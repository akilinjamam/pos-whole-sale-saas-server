import { Types } from 'mongoose';

import { returnValueMinor } from '../../domain/returns.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { assertLocationAllowed, locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { carryAverageCost } from '../../services/itemCost.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { postMovements } from '../../services/stock.service.js';
import { Dispatch } from '../dispatch/dispatch.model.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Location } from '../location/location.model.js';
import { Lot } from '../lot/lot.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';
import { invoicePayload } from '../pos/posSale.service.js';
import { Product } from '../product/product.model.js';
import { WholesaleOrder } from '../wholesaleOrder/wholesaleOrder.model.js';

import { raiseCreditNote, serialize as serializeCreditNotes } from './creditNote.service.js';
import { CreditNote } from './creditNote.model.js';
import { SalesReturn, toSalesReturnPayload } from './salesReturn.model.js';

import type { SalesReturnDoc, SalesReturnLineDoc } from './salesReturn.model.js';
import type { ListSalesReturnsQuery } from './salesReturn.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { MovementInput } from '../../services/stock.service.js';
import type { InvoiceDoc } from '../invoice/invoice.model.js';
import type { WholesaleReturnInput } from '@shared/returns.js';
import type {
  PageMeta,
  ReturnableWholesaleInvoice,
  SalesReturnPayload,
  WholesaleReturnResult,
} from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Wholesale returns (Day 36) — goods back from a dealer against a posted invoice, in one
 * transaction:
 *
 *   1. each line, checked against what is still out on the invoice (quantity, serials) and valued
 *      at its own net price for the units returned (`domain/returns`, cumulative rounding);
 *   2. `SALE_RETURN` stock IN at the location the person chose per line — good stock to a selling
 *      location, damaged stock to a damage location, where it waits to be written off or claimed;
 *   3. the invoice's returned quantities and serials, and the order line's returned counter;
 *   4. the money: a credit note (ledger CREDIT, allocated by default to this invoice) or, for goods
 *      already paid for, a refund — the credit and the cash out, both on the ledger.
 *
 * Any refusal at any step rolls every one of them back.
 */

const REF_TYPE = 'SALES_RETURN';
type Line = InvoiceDoc['lines'][number] & { _id: Types.ObjectId };

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

async function loadWholesaleInvoice(
  actor: RequestActor,
  id: Types.ObjectId,
  session?: ClientSession,
): Promise<InvoiceDoc> {
  const invoice = await Invoice.findOne({ _id: id, orgId: actor.orgId })
    .session(session ?? null)
    .lean();
  if (!invoice || invoice.channel !== 'WHOLESALE' || invoice.series === 'OB') {
    throw refuse('invoiceId', 'No such wholesale invoice');
  }
  if (invoice.status !== 'POSTED') {
    throw refuse('invoiceId', `${invoice.docNo ?? 'That invoice'} is not posted`);
  }
  if (!invoice.partyId) throw refuse('invoiceId', 'That invoice has no dealer');
  return invoice;
}

// ─── The returns screen ─────────────────────────────────────────────────────────────────

/** `GET /sales-returns/invoice/:id` — what can still come back, and where it can go. */
export async function getReturnableWholesaleInvoice(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<ReturnableWholesaleInvoice> {
  const invoice = await loadWholesaleInvoice(actor, id);
  const lines = invoice.lines as Line[];
  const [products, lots, damage, previous] = await Promise.all([
    Product.find({ _id: { $in: lines.map((l) => l.productId) } })
      .select('trackingMode baseUom')
      .lean(),
    Lot.find({ _id: { $in: lines.flatMap((l) => (l.lotId ? [l.lotId] : [])) } })
      .select('lotNo')
      .lean(),
    Location.find({ orgId: actor.orgId, type: 'DAMAGE', isActive: true }).select('_id').lean(),
    SalesReturn.find({ orgId: actor.orgId, invoiceId: invoice._id })
      .sort({ postedAt: 1 })
      .lean(),
  ]);
  return {
    invoice: await invoicePayload(invoice),
    lines: lines.map((l) => {
      const p = products.find((x) => x._id.equals(l.productId));
      const returned = new Set(l.returnedSerials ?? []);
      return {
        invoiceLineId: String(l._id),
        description: l.description,
        productId: String(l.productId),
        variantId: l.variantId ? String(l.variantId) : null,
        uomCode: l.uomCode,
        qtyBase: l.qtyBase,
        returnableBase: l.qtyBase - (l.qtyReturnedBase ?? 0),
        serials: l.serials.filter((s) => !returned.has(s)),
        trackingMode: p?.trackingMode ?? 'NONE',
        baseUom: p?.baseUom ?? l.uomCode,
        lotNo: l.lotId ? (lots.find((x) => x._id.equals(l.lotId!))?.lotNo ?? null) : null,
        unitValueMinor: Math.round(l.lineTotalMinor / l.qtyBase),
      };
    }),
    defaultLocationId: invoice.locationId ? String(invoice.locationId) : null,
    damageLocationIds: damage.map((d) => String(d._id)),
    previousReturns: previous.map(toSalesReturnPayload),
  };
}

// ─── Checking the lines ─────────────────────────────────────────────────────────────────

function planLines(invoice: InvoiceDoc, input: WholesaleReturnInput) {
  const byId = new Map((invoice.lines as Line[]).map((l) => [String(l._id), l]));
  // The same line may come back on two rows — two good to the shelf, one damaged to the damage
  // room — so what is taken is counted per line across rows, and a serial only once.
  const taken = new Map<string, number>();
  const serialsTaken = new Set<string>();
  const errors: { path: string; message: string }[] = [];
  const plan = input.lines.flatMap((r, i) => {
    const at = (f: string) => `lines.${i}.${f}`;
    const line = byId.get(r.invoiceLineId);
    if (!line) {
      errors.push({ path: at('invoiceLineId'), message: 'Not a line of this invoice' });
      return [];
    }
    const before = (line.qtyReturnedBase ?? 0) + (taken.get(r.invoiceLineId) ?? 0);
    const left = line.qtyBase - before;
    if (r.qtyBase > left) {
      errors.push({
        path: at('qtyBase'),
        message:
          left === 0
            ? `${line.description} has already come back in full`
            : `Only ${left} of ${line.description} can still come back`,
      });
      return [];
    }
    let serials: string[] = [];
    if (line.serials.length > 0) {
      serials = [...new Set((r.serials ?? []).map((s) => s.trim().toUpperCase()))];
      const returned = new Set(line.returnedSerials ?? []);
      const bad =
        serials.length !== r.qtyBase
          ? `Name the ${r.qtyBase} serial(s) coming back`
          : (serials
              .map((sn) =>
                !line.serials.includes(sn)
                  ? `${sn} was not sold on this invoice`
                  : returned.has(sn) || serialsTaken.has(sn)
                    ? `${sn} has already come back`
                    : null,
              )
              .find(Boolean) ?? null);
      if (bad) {
        errors.push({ path: at('serials'), message: bad });
        return [];
      }
    }
    serials.forEach((sn) => serialsTaken.add(sn));
    taken.set(r.invoiceLineId, (taken.get(r.invoiceLineId) ?? 0) + r.qtyBase);
    const value = returnValueMinor(
      { lineTotalMinor: line.lineTotalMinor, qtyBase: line.qtyBase, qtyReturnedBase: before },
      r.qtyBase,
    );
    return [{ index: i, line, input: r, serials, value }];
  });
  if (errors.length) throw ApiError.validation('Validation failed', errors);
  return plan;
}

/** Good stock goes to a selling location; damaged stock to a damage location. Never transit. */
async function checkDestinations(actor: RequestActor, input: WholesaleReturnInput) {
  const ids = [...new Set(input.lines.map((l) => l.restockLocationId))];
  const found = await Location.find({ orgId: actor.orgId, _id: { $in: ids } })
    .select('name type isActive')
    .lean();
  const by = new Map(found.map((l) => [String(l._id), l]));
  const errors: { path: string; message: string }[] = [];
  input.lines.forEach((l, i) => {
    const path = `lines.${i}.restockLocationId`;
    const loc = by.get(l.restockLocationId);
    if (!loc || !loc.isActive) return void errors.push({ path, message: 'No such location' });
    if (loc.type === 'TRANSIT') {
      return void errors.push({ path, message: `${loc.name} is a transit location` });
    }
    if (l.condition === 'DAMAGED' && loc.type !== 'DAMAGE') {
      return void errors.push({ path, message: 'Damaged goods go to a damage location' });
    }
    if (l.condition === 'GOOD' && loc.type === 'DAMAGE') {
      return void errors.push({ path, message: `${loc.name} is for damaged goods` });
    }
  });
  if (errors.length) throw ApiError.validation('Validation failed', errors);
  for (const id of ids) assertLocationAllowed(actor.user, id);
}

// ─── Posting ────────────────────────────────────────────────────────────────────────────

export async function postWholesaleReturn(
  actor: RequestActor,
  input: WholesaleReturnInput,
): Promise<WholesaleReturnResult> {
  if (input.settlement === 'CASH_REFUND' && !hasPermission(actor.user, 'return:approve')) {
    throw new ApiError(403, 'FORBIDDEN', 'You need return:approve to refund money');
  }
  const invoiceId = new Types.ObjectId(input.invoiceId);
  planLines(await loadWholesaleInvoice(actor, invoiceId), input); // fail fast
  await checkDestinations(actor, input);

  const returnId = new Types.ObjectId();
  const now = new Date();
  const creditNoteId = await withTransaction(async (session) => {
    // Re-read inside the transaction: this read and the write to the same invoice below are what
    // make two returns racing for one line conflict instead of both succeeding.
    const invoice = await loadWholesaleInvoice(actor, invoiceId, session);
    const plan = planLines(invoice, input);
    const totalMinor = plan.reduce((t, p) => t + p.value, 0);
    if (input.settlement === 'CASH_REFUND' && totalMinor > invoice.paidMinor) {
      throw refuse(
        'settlement',
        `Only ${invoice.paidMinor} was paid on ${invoice.docNo} — settle the rest as a credit note`,
      );
    }
    const docNo = await nextDocNo(session, actor.orgId, 'SR', now);

    // ── Stock back in, where each line was sent ──
    const movements: MovementInput[] = [];
    const lines: SalesReturnLineDoc[] = [];
    for (const p of plan) {
      const locationId = new Types.ObjectId(p.input.restockLocationId);
      movements.push({
        locationId,
        productId: p.line.productId,
        variantId: p.line.variantId,
        qtyBase: p.input.qtyBase,
        movementType: 'SALE_RETURN',
        refType: REF_TYPE,
        refId: returnId,
        refDocNo: docNo,
        unitCostMinor: p.line.costAtSaleMinor,
        lotId: p.line.lotId,
        narration:
          p.input.condition === 'DAMAGED'
            ? `Returned damaged against ${invoice.docNo}`
            : `Returned against ${invoice.docNo}`,
        ...(p.serials.length ? { serials: p.serials } : {}),
      });
      lines.push({
        invoiceLineId: p.line._id,
        productId: p.line.productId,
        variantId: p.line.variantId,
        description: p.line.description,
        lotId: p.line.lotId,
        serials: p.serials,
        qtyBase: p.input.qtyBase,
        unitPriceMinor: Math.round(p.value / p.input.qtyBase),
        lineTotalMinor: p.value,
        condition: p.input.condition,
        restock: true,
        restockLocationId: locationId,
      });
    }
    await postMovements(session, {
      orgId: actor.orgId,
      movements,
      postedAt: now,
      actorId: actor.actorId,
    });
    await carryAverageCost(
      session,
      actor.orgId,
      plan.map((p) => p.line),
    );

    // ── The invoice remembers what came back; a refund also hands the money back ──
    // One update path per invoice line, however many rows it came back on.
    const perLine = new Map<string, { id: Types.ObjectId; qty: number; serials: string[] }>();
    for (const p of plan) {
      const k = String(p.line._id);
      const e = perLine.get(k) ?? { id: p.line._id, qty: 0, serials: [] };
      e.qty += p.input.qtyBase;
      e.serials.push(...p.serials);
      perLine.set(k, e);
    }
    const inc: Record<string, number> = {};
    const push: Record<string, { $each: string[] }> = {};
    const arrayFilters = [...perLine.values()].map((e, i) => {
      inc[`lines.$[l${i}].qtyReturnedBase`] = e.qty;
      if (e.serials.length) push[`lines.$[l${i}].returnedSerials`] = { $each: e.serials };
      return { [`l${i}._id`]: e.id };
    });
    if (input.settlement === 'CASH_REFUND') {
      // Credited with the goods, and the payment for them given back: the balance stands.
      inc.creditedMinor = totalMinor;
      inc.paidMinor = -totalMinor;
    }
    await Invoice.updateOne(
      { _id: invoice._id, orgId: actor.orgId },
      {
        $inc: inc,
        ...(Object.keys(push).length ? { $push: push } : {}),
        $set: { updatedBy: actor.actorId },
      },
      { arrayFilters, session },
    );

    // ── The order line's returned counter, through the challan that shipped it ──
    if (invoice.orderId && invoice.dispatchId) {
      const d = await Dispatch.findById(invoice.dispatchId)
        .select('lines')
        .session(session)
        .lean();
      const byIndex = new Map((invoice.lines as Line[]).map((l, i) => [String(l._id), i]));
      const perOrderLine = new Map<string, { id: Types.ObjectId; qty: number }>();
      for (const e of perLine.values()) {
        const orderLineId = d?.lines[byIndex.get(String(e.id))!]?.orderLineId;
        if (!orderLineId) continue;
        const o = perOrderLine.get(String(orderLineId)) ?? { id: orderLineId, qty: 0 };
        o.qty += e.qty;
        perOrderLine.set(String(orderLineId), o);
      }
      const orderInc: Record<string, number> = {};
      const orderFilters = [...perOrderLine.values()].map((o, i) => {
        orderInc[`lines.$[o${i}].qtyReturnedBase`] = o.qty;
        return { [`o${i}._id`]: o.id };
      });
      if (orderFilters.length) {
        await WholesaleOrder.updateOne(
          { _id: invoice.orderId, orgId: actor.orgId },
          { $inc: orderInc },
          { arrayFilters: orderFilters, session },
        );
      }
    }

    // ── The money ──
    let creditNote: Awaited<ReturnType<typeof raiseCreditNote>> | null = null;
    let refundPaymentId: Types.ObjectId | null = null;
    let refundDocNo: string | null = null;
    const narration = `Return ${docNo} against ${invoice.docNo}`;
    if (input.settlement === 'CREDIT_NOTE') {
      creditNote = await raiseCreditNote(session, actor, {
        channel: 'WHOLESALE',
        partyId: invoice.partyId!,
        salesReturnId: returnId,
        salesReturnDocNo: docNo,
        invoiceId: invoice._id,
        invoiceDocNo: invoice.docNo!,
        amountMinor: totalMinor,
        at: now,
        ...(input.allocations !== undefined ? { allocations: input.allocations } : {}),
        narration,
      });
    } else {
      refundDocNo = await nextDocNo(session, actor.orgId, 'PAY', now);
      refundPaymentId = new Types.ObjectId();
      await PaymentDoc.create(
        [
          {
            _id: refundPaymentId,
            orgId: actor.orgId,
            docNo: refundDocNo,
            series: 'PAY',
            direction: 'OUT',
            partyId: invoice.partyId,
            locationId: invoice.locationId,
            paidAt: now,
            method: input.refundMethod ?? 'CASH',
            amountMinor: totalMinor,
            allocatedMinor: 0,
            unallocatedMinor: 0,
            isRefund: true,
            reference: input.reference ?? null,
            narration: `Refund on ${docNo} for ${invoice.docNo}`,
            collectedByUserId: actor.actorId,
            createdBy: actor.actorId,
            updatedBy: actor.actorId,
          },
        ],
        { session },
      );
      await postLedgerEntries(session, {
        orgId: actor.orgId,
        postedAt: now,
        actorId: actor.actorId,
        entries: [
          {
            partyId: invoice.partyId!,
            docType: 'CREDIT_NOTE',
            refType: REF_TYPE,
            refId: returnId,
            refDocNo: docNo,
            creditMinor: totalMinor,
            narration,
          },
          {
            partyId: invoice.partyId!,
            docType: 'PAYMENT',
            refType: 'PAYMENT',
            refId: refundPaymentId,
            refDocNo: refundDocNo,
            debitMinor: totalMinor,
            narration: `Refunded on ${docNo}`,
          },
        ],
      });
    }

    await SalesReturn.create(
      [
        {
          _id: returnId,
          orgId: actor.orgId,
          docNo,
          channel: 'WHOLESALE',
          invoiceId: invoice._id,
          invoiceDocNo: invoice.docNo!,
          partyId: invoice.partyId,
          customerName: invoice.partySnapshot?.name ?? null,
          locationId: lines[0]!.restockLocationId,
          posSessionId: null,
          returnDate: now,
          reason: input.reason,
          status: 'POSTED',
          lines,
          subtotalMinor: totalMinor,
          taxMinor: 0,
          grandTotalMinor: totalMinor,
          settlement: input.settlement,
          creditNoteDocNo: creditNote?.docNo ?? null,
          creditNoteId: creditNote?._id ?? null,
          refundPaymentId,
          refundDocNo,
          note: input.note ?? null,
          postedAt: now,
          postedBy: actor.actorId,
          createdBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      ],
      { session },
    );
    return creditNote?._id ?? null;
  });

  const [saved, cn] = await Promise.all([
    SalesReturn.findById(returnId).lean(),
    creditNoteId ? CreditNote.findById(creditNoteId).lean() : null,
  ]);
  return {
    salesReturn: toSalesReturnPayload(saved!),
    creditNote: cn ? (await serializeCreditNotes(actor.orgId, [cn]))[0]! : null,
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

/** Both channels' returns. A user tied to locations sees returns into them. */
export async function listSalesReturns(
  actor: RequestActor,
  query: ListSalesReturnsQuery,
): Promise<{ items: SalesReturnPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<SalesReturnDoc> = { orgId: actor.orgId };
  if (query.channel) filter.channel = query.channel;
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.invoiceId) filter.invoiceId = new Types.ObjectId(query.invoiceId);
  const scope = locationScopeOf(actor.user);
  if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  const { items, meta } = await paginate<SalesReturnDoc>(SalesReturn, {
    filter,
    query,
    sortable: ['postedAt', 'docNo', 'grandTotalMinor'],
    searchFields: ['docNo', 'invoiceDocNo', 'creditNoteDocNo', 'customerName'],
    defaultSort: { postedAt: -1, _id: -1 },
  });
  return { items: items.map(toSalesReturnPayload), meta };
}

export async function getSalesReturn(actor: RequestActor, id: Types.ObjectId) {
  const doc = await SalesReturn.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Sales return');
  return toSalesReturnPayload(doc);
}
