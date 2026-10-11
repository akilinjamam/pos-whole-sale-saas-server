import { Types } from 'mongoose';

import { invoicePortion, invoiceQuantity } from '../../domain/dispatchInvoicing.js';
import { roundTotal } from '../../domain/pricing.js';
import {
  lineInvariantViolation,
  lineOutstanding,
  orderTotals,
} from '../../domain/orderQuantities.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { creditExposure } from '../../services/creditExposure.service.js';
import { postMovements } from '../../services/stock.service.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { resolveStockLines, trackingFor } from '../../services/stockLines.js';
import { packFactor } from '../../shared/uom.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { invoicePayload } from '../pos/posSale.service.js';
import { Product } from '../product/product.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';
import { Variant } from '../variant/variant.model.js';
import { WholesaleOrder } from '../wholesaleOrder/wholesaleOrder.model.js';
import {
  auditCreditOverride,
  getOrder,
  transitionOrder,
} from '../wholesaleOrder/wholesaleOrder.service.js';

import { Dispatch, toDispatchPayload } from './dispatch.model.js';

import type { DispatchDoc, DispatchLineDoc } from './dispatch.model.js';
import type { ListDispatchesQuery } from './dispatch.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { MovementInput } from '../../services/stock.service.js';
import type { InvoiceLineDoc } from '../invoice/invoice.model.js';
import type {
  OrderLineDoc,
  WholesaleOrderDoc,
} from '../wholesaleOrder/wholesaleOrder.model.js';
import type {
  CancelDispatchInput,
  CreateDispatchInput,
  DeliverDispatchInput,
  PostDispatchInput,
  DispatchLineInput,
  UpdateDispatchInput,
} from '@shared/dispatch.js';
import type { OrderStatus } from '@shared/enums.js';
import type { DispatchPayload, DispatchPostResult, PageMeta } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Dispatch — pick, pack, post (§7 "Partial dispatch", Day 24).
 *
 *   create (DRAFT)  the pick list, against a confirmed order. Order → PICKING.
 *   pack   (PACKED) lots and serials captured, as the product's `trackingMode` demands. Order → PACKED.
 *   post            ONE transaction:
 *                     re-read the order with the session and re-validate every line against what
 *                     is still to ship → post `SALE` movements, releasing the reservation → move
 *                     the order lines' counters → number the challan → (invoiceOnDispatch) post the
 *                     invoice for exactly these lines and the dealer's ledger DEBIT → order →
 *                     PARTIALLY_DISPATCHED or DISPATCHED.
 *
 * The re-read inside the transaction is what makes two pickers posting the same line safe: both
 * read the order, both write it, and the second write conflicts — its retry re-reads the order,
 * finds the line already shipped, and is refused. Stock is guarded the same way, by the balance.
 *
 * Credit is not re-checked at post yet: Day 31 adds that, beside the confirm-time check.
 */

const OPEN: DispatchDoc['status'][] = ['DRAFT', 'PACKED'];
/** Orders a challan may be raised against. */
const DISPATCHABLE: OrderStatus[] = ['CONFIRMED', 'PICKING', 'PACKED', 'PARTIALLY_DISPATCHED'];

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);
const conflict = (message: string, details?: Record<string, unknown>) =>
  ApiError.conflict('ILLEGAL_TRANSITION', message, details);

/** Outside the caller's locations, a challan does not exist for them. */
function assertCanSee(actor: RequestActor, doc: { locationId: Types.ObjectId }): void {
  const scope = locationScopeOf(actor.user);
  if (scope && !scope.includes(String(doc.locationId))) throw ApiError.notFound('Dispatch');
}

async function loadOrder(
  actor: RequestActor,
  id: Types.ObjectId,
  session?: ClientSession,
): Promise<WholesaleOrderDoc> {
  const order = await WholesaleOrder.findOne({ _id: id, orgId: actor.orgId, isDeleted: false })
    .session(session ?? null)
    .lean();
  if (!order) throw ApiError.notFound('Order');
  assertCanSee(actor, order);
  return order;
}

async function loadDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
  session?: ClientSession,
): Promise<DispatchDoc> {
  const doc = await Dispatch.findOne({ _id: id, orgId: actor.orgId })
    .session(session ?? null)
    .lean();
  if (!doc) throw ApiError.notFound('Dispatch');
  assertCanSee(actor, doc);
  return doc;
}

// ─── Lines ──────────────────────────────────────────────────────────────────────────────

type ResolvedLine = Omit<DispatchLineDoc, '_id' | 'lotId'>;

/**
 * Turn requested challan lines into stored ones, checked against the order as it is now:
 *
 *  - each line names a line of *this* order; product and variant come from it, never the body;
 *  - per order line, the challan's total ≤ what is still to ship (a lot-tracked line may be split
 *    across lots, so the check is on the sum);
 *  - lots and serials as the product's tracking demands — the same rules as every stock document,
 *    via `resolveStockLines`. A draft may leave them blank (`requireCapture: false`); packing may not.
 *
 * Omitted lines mean "everything still to ship".
 */
async function resolveLines(
  actor: RequestActor,
  order: WholesaleOrderDoc,
  input: readonly DispatchLineInput[] | undefined,
  { requireCapture }: { requireCapture: boolean },
): Promise<ResolvedLine[]> {
  const byId = new Map(order.lines.map((l) => [String(l._id), l]));
  const requested: readonly DispatchLineInput[] =
    input ??
    order.lines
      .filter((l) => lineOutstanding(l) > 0)
      .map((l) => ({ orderLineId: String(l._id), qtyBase: lineOutstanding(l) }));
  if (requested.length === 0) throw refuse('lines', 'Nothing is left to ship on this order');

  const totalFor = new Map<string, number>();
  requested.forEach((r, i) => {
    const ol = byId.get(r.orderLineId);
    if (!ol) throw refuse(`lines.${i}.orderLineId`, 'Not a line of this order');
    totalFor.set(r.orderLineId, (totalFor.get(r.orderLineId) ?? 0) + r.qtyBase);
  });
  requested.forEach((r, i) => {
    const ol = byId.get(r.orderLineId)!;
    const left = lineOutstanding(ol);
    if (totalFor.get(r.orderLineId)! > left) {
      throw refuse(
        `lines.${i}.qtyBase`,
        left === 0
          ? `Line ${ol.lineNo} has nothing left to ship`
          : `Line ${ol.lineNo} has only ${left} left to ship`,
      );
    }
  });

  const stock = await resolveStockLines(
    actor.orgId,
    requested.map((r) => {
      const ol = byId.get(r.orderLineId)!;
      return {
        productId: String(ol.productId),
        variantId: ol.variantId ? String(ol.variantId) : null,
        uomCode: null, // base units
        qty: r.qtyBase,
        lotNo: r.lotNo ?? null,
        serials: r.serials,
      };
    }),
    { requireCapture },
  );

  return requested.map((r, i) => ({
    orderLineId: byId.get(r.orderLineId)!._id,
    productId: stock[i]!.productId,
    variantId: stock[i]!.variantId,
    qtyBase: stock[i]!.qtyBase,
    lotNo: stock[i]!.lotNo,
    serials: stock[i]!.serials,
  }));
}

const asInput = (lines: readonly DispatchLineDoc[]): DispatchLineInput[] =>
  lines.map((l) => ({
    orderLineId: String(l.orderLineId),
    qtyBase: l.qtyBase,
    lotNo: l.lotNo,
    ...(l.serials?.length ? { serials: l.serials } : {}),
  }));

function transportOf(input: CreateDispatchInput['transport']): DispatchDoc['transport'] {
  if (!input) return null;
  return {
    mode: input.mode,
    vehicleNo: input.vehicleNo ?? null,
    driverName: input.driverName ?? null,
    driverPhone: input.driverPhone ?? null,
    courierName: input.courierName ?? null,
    trackingNo: input.trackingNo ?? null,
    freightMinor: input.freightMinor ?? 0,
    freightPaidBy: input.freightPaidBy ?? 'US',
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

async function serialize(
  actor: RequestActor,
  docs: DispatchDoc[],
  { withSignature = false } = {},
): Promise<DispatchPayload[]> {
  const ids = (pick: (d: DispatchDoc) => (Types.ObjectId | null)[]) => [
    ...new Set(docs.flatMap(pick).filter(Boolean).map(String)),
  ];
  const [dealers, locations, products, variants] = await Promise.all([
    Party.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.dealerPartyId]) } })
      .select('name displayName')
      .lean(),
    Location.find({ orgId: actor.orgId, _id: { $in: ids((d) => [d.locationId]) } })
      .select('name')
      .lean(),
    Product.find({
      orgId: actor.orgId,
      _id: { $in: ids((d) => d.lines.map((l) => l.productId)) },
    })
      .select('name sku trackingMode baseUom packs')
      .lean(),
    Variant.find({
      orgId: actor.orgId,
      _id: { $in: ids((d) => d.lines.map((l) => l.variantId)) },
    })
      .select('sku')
      .lean(),
  ]);
  const dealerBy = new Map(dealers.map((p) => [String(p._id), p.displayName ?? p.name]));
  const locationBy = new Map(locations.map((l) => [String(l._id), l.name]));
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), v.sku]));
  return docs.map((d) =>
    toDispatchPayload(d, {
      dealerName: dealerBy.get(String(d.dealerPartyId)),
      locationName: locationBy.get(String(d.locationId)),
      product: (id) => productBy.get(String(id)),
      variantSku: (id) => (id ? variantBy.get(String(id)) : undefined),
      withSignature,
    }),
  );
}

/** One challan, in full — including the delivery signature a list leaves out. */
const one = async (actor: RequestActor, doc: DispatchDoc) =>
  (await serialize(actor, [doc], { withSignature: true }))[0]!;

export async function listDispatches(
  actor: RequestActor,
  query: ListDispatchesQuery,
): Promise<{ items: DispatchPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<DispatchDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (query.locationId) filter.locationId = new Types.ObjectId(query.locationId);
  else if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.status) filter.status = query.status;
  if (query.orderId) filter.orderId = new Types.ObjectId(query.orderId);
  if (query.dealerPartyId) filter.dealerPartyId = new Types.ObjectId(query.dealerPartyId);

  const { items, meta } = await paginate<DispatchDoc>(Dispatch, {
    filter,
    query,
    sortable: ['createdAt', 'dispatchedAt', 'docNo'],
    searchFields: ['docNo', 'orderDocNo', 'invoiceDocNo', 'note'],
    defaultSort: { createdAt: -1 },
  });
  return { items: await serialize(actor, items), meta };
}

export async function getDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<DispatchPayload> {
  return one(actor, await loadDispatch(actor, id));
}

// ─── Create, edit, pack, cancel ─────────────────────────────────────────────────────────

/** A pick list against a confirmed order. The order moves to PICKING if it is not already. */
export async function createDispatch(
  actor: RequestActor,
  input: CreateDispatchInput,
): Promise<DispatchPayload> {
  const orderId = new Types.ObjectId(input.orderId);
  const doc = await withTransaction(async (session) => {
    const order = await loadOrder(actor, orderId, session);
    if (!DISPATCHABLE.includes(order.status)) {
      throw conflict(
        `${order.docNo ?? 'This order'} is ${order.status} — nothing can be dispatched against it`,
      );
    }
    const lines = await resolveLines(actor, order, input.lines, { requireCapture: false });

    const [created] = await Dispatch.create(
      [
        {
          orgId: actor.orgId,
          orderId: order._id,
          orderDocNo: order.docNo,
          dealerPartyId: order.dealerPartyId,
          locationId: order.locationId,
          lines,
          transport: transportOf(input.transport),
          packages: input.packages ?? [],
          note: input.note ?? null,
          createdBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      ],
      { session },
    );
    if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_DISPATCHED') {
      await transitionOrder(actor, order._id, 'PICKING', { session });
    }
    return created!.toObject();
  });
  return one(actor, doc);
}

export async function updateDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
  input: UpdateDispatchInput,
): Promise<DispatchPayload> {
  const doc = await loadDispatch(actor, id);
  if (!OPEN.includes(doc.status)) {
    throw conflict(
      `${doc.docNo ?? 'This challan'} is ${doc.status} — it can no longer be changed`,
    );
  }
  const $set: Record<string, unknown> = { updatedBy: actor.actorId };
  if (input.lines) {
    if (doc.status !== 'DRAFT') {
      throw conflict(
        'This challan is packed — cancel it and pick again to change what is in it',
      );
    }
    const order = await loadOrder(actor, doc.orderId);
    $set.lines = await resolveLines(actor, order, input.lines, { requireCapture: false });
  }
  if (input.transport !== undefined) $set.transport = transportOf(input.transport);
  if (input.packages !== undefined) $set.packages = input.packages;
  if (input.note !== undefined) $set.note = input.note;

  // Conditioned on the status read: a pack or post that lands in between wins, and we 409.
  const updated = await Dispatch.findOneAndUpdate(
    { _id: doc._id, orgId: actor.orgId, status: doc.status },
    { $set },
    { new: true },
  ).lean();
  if (!updated)
    throw conflict('The challan changed while you were editing it — reload and try again');
  return one(actor, updated);
}

/**
 * Packed: every lot and serial captured, quantities still within what the order has left. The
 * order moves PICKING → PACKED (another challan may already have moved it further; then it stays).
 */
export async function packDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<DispatchPayload> {
  const doc = await withTransaction(async (session) => {
    const d = await loadDispatch(actor, id, session);
    if (d.status !== 'DRAFT')
      throw conflict(`This challan is ${d.status} — only a draft can be packed`);
    const order = await loadOrder(actor, d.orderId, session);
    const lines = await resolveLines(actor, order, asInput(d.lines), { requireCapture: true });

    const packed = await Dispatch.findOneAndUpdate(
      { _id: d._id, orgId: actor.orgId, status: 'DRAFT' },
      {
        $set: {
          status: 'PACKED',
          lines: lines.map((l, i) => ({ ...l, _id: d.lines[i]!._id })),
          packedAt: new Date(),
          packedBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (order.status === 'PICKING')
      await transitionOrder(actor, order._id, 'PACKED', { session });
    return packed!;
  });
  return one(actor, doc);
}

/** Abandon a draft or packed challan. Nothing has moved, so nothing moves back. */
export async function cancelDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
  input: CancelDispatchInput,
): Promise<DispatchPayload> {
  const doc = await loadDispatch(actor, id);
  const updated = await Dispatch.findOneAndUpdate(
    { _id: doc._id, orgId: actor.orgId, status: { $in: OPEN } },
    {
      $set: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: actor.actorId,
        cancelReason: input.reason,
        updatedBy: actor.actorId,
      },
    },
    { new: true },
  ).lean();
  if (!updated) {
    throw conflict(
      doc.status === 'DISPATCHED' || doc.status === 'DELIVERED'
        ? 'A posted challan cannot be cancelled — goods that came back are a sales return'
        : `This challan is already ${doc.status}`,
    );
  }
  return one(actor, updated);
}

// ─── Credit at dispatch (Day 31) ────────────────────────────────────────────────────────

/**
 * The dealer's credit, re-checked as the goods leave (§8): the balance may have moved since the
 * order was confirmed — a cheque bounced, another order confirmed, the limit cut.
 *
 *   on hold            refused, always: a hold is a person's decision, and goods do not leave.
 *   order overridden   passes: a manager already lent this order past the limit, knowingly.
 *   otherwise          exposure (this order already in it, as an open order) against the limit;
 *                      over it, refused — unless the caller holds `order:creditOverride` and gives
 *                      a reason, which is recorded on the order and in the audit log.
 */
async function checkCreditAtDispatch(
  session: ClientSession,
  actor: RequestActor,
  order: WholesaleOrderDoc,
  enforce: boolean,
  overrideReason: string | undefined,
): Promise<void> {
  const dealer = (await Party.findById(order.dealerPartyId).session(session).lean())!;
  if (dealer.dealer?.creditHold) {
    throw ApiError.conflict(
      'CREDIT_LIMIT_EXCEEDED',
      `${dealer.name} is on credit hold${dealer.dealer.creditHoldReason ? `: ${dealer.dealer.creditHoldReason}` : ''} — nothing leaves until it is lifted`,
      { reason: 'ON_HOLD', canOverride: false },
    );
  }
  if (!enforce || order.creditCheck?.status === 'OVERRIDDEN') return;

  const exposure = await creditExposure(actor.orgId, dealer._id, { session });
  const limitMinor = dealer.dealer?.creditLimitMinor ?? 0;
  if (exposure.exposureMinor <= limitMinor) return;

  const shortfallMinor = exposure.exposureMinor - limitMinor;
  const canOverride = hasPermission(actor.user, 'order:creditOverride');
  if (!canOverride || !overrideReason) {
    throw ApiError.conflict(
      'CREDIT_LIMIT_EXCEEDED',
      `${dealer.name} is now over their credit limit — this challan cannot leave on credit`,
      {
        reason: 'OVER_LIMIT',
        canOverride,
        exposureMinor: exposure.exposureMinor,
        limitMinor,
        shortfallMinor,
      },
    );
  }
  const credit = {
    verdict: 'OVER_LIMIT',
    limitMinor,
    exposureMinor: exposure.exposureMinor,
    exposureAfterMinor: exposure.exposureMinor,
    shortfallMinor,
  };
  await WholesaleOrder.updateOne(
    { _id: order._id, orgId: actor.orgId },
    {
      $set: {
        creditCheck: {
          status: 'OVERRIDDEN',
          checkedAt: new Date(),
          outstandingMinor: exposure.exposureMinor,
          exposureMinor: exposure.exposureMinor,
          limitMinor,
          overriddenByUserId: actor.actorId,
          overrideReason,
        },
        updatedBy: actor.actorId,
      },
    },
    { session },
  );
  await auditCreditOverride(session, actor, order, 'DISPATCH', overrideReason, credit);
}

// ─── Post ───────────────────────────────────────────────────────────────────────────────

export interface PostDispatchOptions {
  /** Test-only: runs inside the transaction after every write, before the commit. */
  beforeCommit?: () => Promise<void> | void;
}

export async function postDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
  options: PostDispatchOptions = {},
  input: PostDispatchInput = {},
): Promise<DispatchPostResult> {
  const org = await Org.findById(actor.orgId)
    .select('settings.invoiceOnDispatch settings.enforceCreditLimit settings.roundInvoiceTo')
    .lean();
  const invoicing = org?.settings?.invoiceOnDispatch ?? true;
  const enforce = org?.settings?.enforceCreditLimit ?? true;

  const posted = await withTransaction(async (session) => {
    const now = new Date();
    const d = await loadDispatch(actor, id, session);
    if (d.status !== 'PACKED') {
      throw conflict(
        d.status === 'DRAFT'
          ? 'Pack the challan before posting it'
          : `This challan is already ${d.status}`,
      );
    }

    // ── 1. The order, as of this transaction — and every line re-validated against it ──
    const order = await loadOrder(actor, d.orderId, session);
    await checkCreditAtDispatch(session, actor, order, enforce, input.creditOverrideReason);
    const lineBy = new Map(order.lines.map((l) => [String(l._id), { ...l }]));
    const shipping = new Map<string, number>();
    for (const l of d.lines) {
      shipping.set(
        String(l.orderLineId),
        (shipping.get(String(l.orderLineId)) ?? 0) + l.qtyBase,
      );
    }
    for (const [lineId, qty] of shipping) {
      const ol = lineBy.get(lineId);
      if (!ol) throw conflict('The order no longer has a line this challan ships against');
      const left = lineOutstanding(ol);
      if (qty > left) {
        throw conflict(
          `Line ${ol.lineNo}: only ${left} left to ship, this challan has ${qty} — another challan got there first`,
          { orderLineId: lineId, requested: qty, outstanding: left },
        );
      }
    }

    const docNo = await nextDocNo(session, actor.orgId, 'CHL', now);
    const invoiceId = invoicing ? new Types.ObjectId() : null;
    const invoiceDocNo = invoicing ? await nextDocNo(session, actor.orgId, 'WS', now) : null;

    // ── 2. Stock: SALE movements, each releasing what the order reserved for it ──
    const products = await Product.find({
      orgId: actor.orgId,
      _id: { $in: d.lines.map((l) => l.productId) },
    })
      .select('name sku baseUom packs')
      .session(session)
      .lean();
    const productBy = new Map(products.map((p) => [String(p._id), p]));
    const costs = await StockBalance.find({
      orgId: actor.orgId,
      locationId: order.locationId,
      productId: { $in: d.lines.map((l) => l.productId) },
    })
      .select('productId variantId avgCostMinor')
      .session(session)
      .lean();
    const costOf = (l: DispatchLineDoc) =>
      costs.find(
        (c) =>
          c.productId.equals(l.productId) &&
          String(c.variantId ?? '') === String(l.variantId ?? ''),
      )?.avgCostMinor ?? null;

    const reservedLeft = new Map(order.lines.map((l) => [String(l._id), l.qtyReservedBase]));
    const movements: MovementInput[] = [];
    const lotIds: (Types.ObjectId | null)[] = [];
    for (const l of d.lines) {
      const p = productBy.get(String(l.productId))!;
      const tracking = await trackingFor(
        session,
        actor.orgId,
        {
          productId: l.productId,
          variantId: l.variantId,
          uomCode: p.baseUom,
          qty: l.qtyBase,
          qtyBase: l.qtyBase,
          lotNo: l.lotNo,
          mfgDate: null,
          expiryDate: null,
          serials: l.serials ?? [],
        },
        'OUT',
        actor.actorId,
      );
      lotIds.push(tracking.lotId);
      const key = String(l.orderLineId);
      const release = Math.min(l.qtyBase, reservedLeft.get(key) ?? 0);
      reservedLeft.set(key, (reservedLeft.get(key) ?? 0) - release);
      const ol = lineBy.get(key)!;
      movements.push({
        locationId: order.locationId,
        productId: l.productId,
        variantId: l.variantId,
        qtyBase: -l.qtyBase,
        movementType: 'SALE',
        refType: 'DISPATCH',
        refId: d._id,
        refDocNo: docNo,
        unitCostMinor: costOf(l),
        releaseReservedBase: release,
        ...tracking,
        sale: {
          partyId: order.dealerPartyId,
          invoiceId,
          sellPriceMinor: Math.round(ol.lineTotalMinor / ol.qtyBase),
        },
      });
    }
    await postMovements(session, {
      orgId: actor.orgId,
      movements,
      postedAt: now,
      actorId: actor.actorId,
    });

    // ── 3. The invoice: exactly these units, at the order's prices ──
    const invoicedBefore = orderTotals(order.lines).invoicedBase;
    const invoiceLines: InvoiceLineDoc[] = [];
    if (invoicing) {
      for (const [i, l] of d.lines.entries()) {
        const ol = lineBy.get(String(l.orderLineId))!;
        const p = productBy.get(String(l.productId))!;
        const portion = invoicePortion(ol, l.qtyBase);
        ol.qtyInvoicedBase += l.qtyBase; // the next split of the same line continues from here
        const factor =
          packFactor({ baseUom: p.baseUom, packs: p.packs ?? [] }, ol.uomCode) ?? 1;
        invoiceLines.push({
          productId: l.productId,
          variantId: l.variantId,
          description: p.name,
          lotId: lotIds[i] ?? null,
          serials: l.serials ?? [],
          ...invoiceQuantity(
            l.qtyBase,
            { uomCode: ol.uomCode, factor, unitPriceMinor: ol.unitPriceMinor },
            p.baseUom,
          ),
          qtyBase: l.qtyBase,
          discountMinor: portion.discountMinor,
          taxPct: 0,
          taxMinor: 0,
          lineTotalMinor: portion.netMinor,
          costAtSaleMinor: costOf(l),
          priceOverridden: ol.priceOverridden,
          originalPriceMinor: ol.originalPriceMinor,
          qtyReturnedBase: 0,
          returnedSerials: [],
        });
      }
    }

    // ── 4. The order's counters ──
    for (const [lineId, qty] of shipping) {
      const ol = lineBy.get(lineId)!;
      ol.qtyDispatchedBase += qty;
      ol.qtyReservedBase = reservedLeft.get(lineId) ?? 0;
    }
    const newLines: OrderLineDoc[] = order.lines.map((l) => lineBy.get(String(l._id))!);
    for (const l of newLines) {
      const bad = lineInvariantViolation(l);
      if (bad) throw ApiError.internal(`Order line ${l.lineNo} after dispatch: ${bad}`);
    }
    await WholesaleOrder.updateOne(
      { _id: order._id, orgId: actor.orgId },
      { $set: { lines: newLines, updatedBy: actor.actorId } },
      { session },
    );

    if (invoicing) {
      const dealer = (await Party.findById(order.dealerPartyId).session(session).lean())!;
      const freight = d.transport?.freightPaidBy === 'DEALER' ? d.transport.freightMinor : 0;
      // The order's own shipping charge rides on its first invoice; dealer-paid freight on each.
      const shippingMinor = (invoicedBefore === 0 ? order.shippingMinor : 0) + freight;
      const subtotalMinor = invoiceLines.reduce(
        (s, l) => s + l.lineTotalMinor + l.discountMinor,
        0,
      );
      const discountMinor = invoiceLines.reduce((s, l) => s + l.discountMinor, 0);
      // The org's rounding (Day 39), recorded as its own figure so the lines still add up.
      const { totalMinor: grandTotalMinor, roundingMinor } = roundTotal(
        subtotalMinor - discountMinor + shippingMinor,
        org?.settings?.roundInvoiceTo ?? 0,
      );
      const dueDate = new Date(now.getTime() + order.paymentTermsDays * 86_400_000);

      await Invoice.create(
        [
          {
            _id: invoiceId,
            orgId: actor.orgId,
            docNo: invoiceDocNo,
            series: 'WS',
            channel: 'WHOLESALE',
            partyId: dealer._id,
            partySnapshot: {
              name: dealer.displayName ?? dealer.name,
              phone: dealer.phone ?? null,
              address: order.billingAddress ?? order.shippingAddress ?? null,
              tin: dealer.tin ?? null,
              bin: dealer.bin ?? null,
            },
            locationId: order.locationId,
            orderId: order._id,
            dispatchId: d._id,
            invoiceDate: now,
            dueDate,
            paymentTermsDays: order.paymentTermsDays,
            status: 'POSTED',
            lines: invoiceLines,
            subtotalMinor,
            discountMinor,
            taxMinor: 0,
            shippingMinor,
            roundingMinor,
            grandTotalMinor,
            paidMinor: 0,
            balanceMinor: grandTotalMinor,
            paymentStatus: grandTotalMinor === 0 ? 'PAID' : 'UNPAID',
            salespersonUserId: order.salespersonUserId,
            postedAt: now,
            postedBy: actor.actorId,
            createdBy: actor.actorId,
            updatedBy: actor.actorId,
          },
        ],
        { session },
      );
      if (grandTotalMinor > 0) {
        await postLedgerEntries(session, {
          orgId: actor.orgId,
          postedAt: now,
          actorId: actor.actorId,
          entries: [
            {
              partyId: dealer._id,
              docType: 'INVOICE',
              refType: 'INVOICE',
              refId: invoiceId,
              refDocNo: invoiceDocNo,
              debitMinor: grandTotalMinor,
              dueDate,
              narration: `Invoice ${invoiceDocNo} for challan ${docNo} (order ${order.docNo})`,
            },
          ],
        });
      }
    }

    // ── 5. The challan, and the order's status ──
    const updated = await Dispatch.findOneAndUpdate(
      { _id: d._id, orgId: actor.orgId, status: 'PACKED' },
      {
        $set: {
          status: 'DISPATCHED',
          docNo,
          lines: d.lines.map((l, i) => ({ ...l, lotId: lotIds[i] ?? null })),
          invoiceId,
          invoiceDocNo,
          dispatchedAt: now,
          dispatchedBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!updated)
      throw conflict('The challan changed while it was being posted — reload and try again');

    // A sibling challan may have sent the order back to PICKING while this one sat packed: this
    // one *was* packed, so record that first, then the dispatch.
    if (order.status === 'PICKING')
      await transitionOrder(actor, order._id, 'PACKED', { session });
    const outstanding = orderTotals(newLines).outstandingBase;
    await transitionOrder(
      actor,
      order._id,
      outstanding === 0 ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED',
      {
        session,
      },
    );

    await options.beforeCommit?.();
    return updated;
  });

  const invoice = posted.invoiceId ? await Invoice.findById(posted.invoiceId).lean() : null;
  return {
    dispatch: await one(actor, posted),
    order: await getOrder(actor, posted.orderId),
    invoice: invoice ? await invoicePayload(invoice) : null,
  };
}

// ─── Deliver (Day 25) ───────────────────────────────────────────────────────────────────

/**
 * Proof of delivery: the dealer's person signed for this challan. DISPATCHED → DELIVERED, with
 * who, when and (optionally) the signature. Nothing moves — the stock left and the invoice was
 * raised when the challan was posted.
 *
 * When this was the order's last undelivered challan and nothing is left to ship, the order moves
 * DISPATCHED → DELIVERED in the same transaction. A partly shipped order stays as it is: delivery
 * of half an order is not delivery of the order.
 */
export async function deliverDispatch(
  actor: RequestActor,
  id: Types.ObjectId,
  input: DeliverDispatchInput,
): Promise<DispatchPayload> {
  const doc = await withTransaction(async (session) => {
    const d = await loadDispatch(actor, id, session);
    if (d.status !== 'DISPATCHED') {
      throw conflict(
        d.status === 'DELIVERED'
          ? `${d.docNo} is already delivered`
          : `This challan is ${d.status} — only a posted challan can be delivered`,
      );
    }
    const deliveredAt = input.deliveredAt ? new Date(input.deliveredAt) : new Date();
    // To the minute: that is all a delivery form can say, and 12:05 is not "before" 12:05:37.
    const postedMinute = d.dispatchedAt
      ? Math.floor(d.dispatchedAt.getTime() / 60_000) * 60_000
      : 0;
    if (d.dispatchedAt && deliveredAt.getTime() < postedMinute) {
      throw refuse('deliveredAt', 'Cannot be before the challan was dispatched');
    }
    const delivered = await Dispatch.findOneAndUpdate(
      { _id: d._id, orgId: actor.orgId, status: 'DISPATCHED' },
      {
        $set: {
          status: 'DELIVERED',
          deliveredAt,
          deliveredBy: actor.actorId,
          receivedByName: input.receivedByName,
          receivedPhone: input.receivedPhone ?? null,
          receivedSignatureUrl: input.signatureDataUrl ?? null,
          deliveryNote: input.note ?? null,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!delivered) throw conflict('The challan changed meanwhile — reload and try again');

    const order = await loadOrder(actor, d.orderId, session);
    const stillOnTheRoad = await Dispatch.countDocuments({
      orgId: actor.orgId,
      orderId: order._id,
      status: 'DISPATCHED',
    }).session(session);
    if (order.status === 'DISPATCHED' && stillOnTheRoad === 0) {
      await transitionOrder(actor, order._id, 'DELIVERED', { session });
    }
    return delivered;
  });
  return one(actor, doc);
}
