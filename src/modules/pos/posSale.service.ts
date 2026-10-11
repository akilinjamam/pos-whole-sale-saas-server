import { mongo, Types } from 'mongoose';

import { checkCredit } from '../../domain/creditCheck.js';
import { applyTenders, TenderError } from '../../domain/tenders.js';
import { computeTotals, PricingError, roundTotal } from '../../domain/pricing.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { creditExposure } from '../../services/creditExposure.service.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { postMovements } from '../../services/stock.service.js';
import { resolveStockLines, trackingFor } from '../../services/stockLines.js';
import { describeAxes } from '../../shared/variant.js';
import { Invoice, toInvoicePayload } from '../invoice/invoice.model.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';
import { resolveForRequest } from '../pricing/pricing.service.js';
import { Product } from '../product/product.model.js';
import { SalesReturn } from '../salesReturn/salesReturn.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';
import { User } from '../user/user.model.js';
import { Variant } from '../variant/variant.model.js';

import { HeldSale } from './heldSale.model.js';
import { PosSession } from './posSession.model.js';

import type { InvoiceDoc, InvoiceLineDoc } from '../invoice/invoice.model.js';
import type { PaymentDocDoc } from '../payment/paymentDoc.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { MovementInput } from '../../services/stock.service.js';
import type { StockDocLineDoc } from '../stock/stockDocLine.js';
import type { PosSaleInput } from '@shared/pos.js';
import type { InvoicePayload, PosQuote, PosSaleResult } from '@shared/types.js';

/**
 * `POST /pos/sales` — the counter sale, §9. **One endpoint, one transaction:**
 *
 *   resolve prices server-side → allocate a `POS` number → post the Invoice → post a numbered
 *   receipt per tender → post the `SALE` stock movements → (credit) post the ledger and check
 *   the dealer's credit
 *
 * Either all of that is committed or none of it is. A sale refused for stock, for credit or for a
 * serial already sold leaves no invoice, no receipt, no stock movement and no used number behind —
 * and the same holds if the process dies half-way, because nothing is visible until the commit.
 *
 * Everything that only *reads* — prices, products, the tender arithmetic — happens before the
 * transaction, so the transaction itself is short and holds its locks for as little time as
 * possible. Anything whose value matters at commit (stock, credit) is re-checked inside it.
 */

export interface PostSaleOptions {
  /**
   * Test-only fault injection: called inside the transaction after every write and before the
   * commit. The integration test uses it to kill the process at the worst possible moment and
   * prove nothing partial survives. Never set by the HTTP route.
   */
  beforeCommit?: () => Promise<void> | void;
}

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

/** An invoice with the names a printed receipt shows — the counter and the cashier. */
export async function invoicePayload(doc: InvoiceDoc): Promise<InvoicePayload> {
  const [location, user] = await Promise.all([
    Location.findById(doc.locationId).select('name').lean(),
    doc.salespersonUserId ? User.findById(doc.salespersonUserId).select('name').lean() : null,
  ]);
  return {
    ...toInvoicePayload(doc),
    locationName: location?.name,
    salespersonName: user?.name,
  };
}

async function replay(actor: RequestActor, invoice: InvoiceDoc): Promise<PosSaleResult> {
  const payments = await PaymentDoc.find({
    orgId: actor.orgId,
    direction: 'IN',
    'allocations.invoiceId': invoice._id,
  })
    .sort({ docNo: 1 })
    .lean();
  return {
    invoice: await invoicePayload(invoice),
    payments: payments.map(paymentPayload),
    changeMinor: 0,
    replayed: true,
  };
}

const paymentPayload = (p: PaymentDocDoc) => ({
  id: String(p._id),
  docNo: p.docNo,
  method: p.method,
  amountMinor: p.amountMinor,
  paidAt: p.paidAt.toISOString(),
});

/** The cart as a sale or a quote sees it: a customer, lines and quantities, discounts. */
export type CartInput = Pick<PosSaleInput, 'lines' | 'partyId' | 'orderDiscount'>;

/**
 * Validate a cart and price it — **the one pricing path** for both `POST /pos/quote` and the sale.
 *
 * Everything the till shows (unit prices, discounts, line and order totals) comes from here, so
 * the number on the screen is the number the sale charges, to the poisha. `requireCapture: false`
 * lets a quote price a machine whose serial has not been scanned yet; the sale always requires it.
 */
export async function priceCart(
  actor: RequestActor,
  input: CartInput,
  { requireCapture = true } = {},
) {
  // ── The customer ──
  const party = input.partyId
    ? await Party.findOne({ _id: input.partyId, orgId: actor.orgId, isActive: true }).lean()
    : null;
  if (input.partyId && !party) throw refuse('partyId', 'No such customer or dealer');
  const isDealer = Boolean(party?.roles.includes('DEALER'));

  // ── Lines: product, variant, unit, lot and serial rules (shared with every stock document) ──
  const stockLines = await resolveStockLines(
    actor.orgId,
    input.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      uomCode: l.uomCode,
      qty: l.qty,
      lotNo: l.lotNo,
      serials: l.serials,
    })),
    { requireCapture },
  );
  const products = await Product.find({
    orgId: actor.orgId,
    _id: { $in: stockLines.map((l) => l.productId) },
  })
    .select('name sku isActive isSellableAtCounter trackingMode baseUom')
    .lean();
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  stockLines.forEach((l, i) => {
    const p = productBy.get(String(l.productId))!;
    if (!p.isActive || !p.isSellableAtCounter)
      throw refuse(`lines.${i}.productId`, `${p.sku} is not sold at the counter`);
  });
  const variants = await Variant.find({
    orgId: actor.orgId,
    _id: { $in: stockLines.flatMap((l) => (l.variantId ? [l.variantId] : [])) },
  })
    .select('axes')
    .lean();
  const variantLabel = new Map(variants.map((v) => [String(v._id), describeAxes(v.axes)]));

  // ── Prices, resolved here — never taken from the till ──
  const canOverride = hasPermission(actor.user, 'order:priceOverride');
  const canDiscount = hasPermission(actor.user, 'pos:discount');
  const priced = await Promise.all(
    input.lines.map(async (line, i) => {
      const l = stockLines[i]!;
      const resolved = await resolveForRequest(actor.orgId, {
        productId: String(l.productId),
        ...(l.variantId ? { variantId: String(l.variantId) } : {}),
        ...(party && isDealer ? { partyId: String(party._id) } : {}),
        uomCode: l.uomCode,
        qty: l.qty,
      });
      let unitPriceMinor = resolved.unitPriceMinor;
      let overridden = false;
      if (
        line.unitPriceMinor !== undefined &&
        line.unitPriceMinor !== resolved.unitPriceMinor
      ) {
        if (!canOverride)
          throw new ApiError(
            403,
            'FORBIDDEN',
            'Changing a price needs the order:priceOverride permission',
            { required: ['order:priceOverride'], fields: [`lines.${i}.unitPriceMinor`] },
          );
        unitPriceMinor = line.unitPriceMinor;
        overridden = true;
      }
      if ((line.lineDiscountMinor ?? 0) > 0 && !canDiscount) {
        throw new ApiError(403, 'FORBIDDEN', 'Discounts need the pos:discount permission', {
          required: ['pos:discount'],
          fields: [`lines.${i}.lineDiscountMinor`],
        });
      }
      return { unitPriceMinor, resolvedMinor: resolved.unitPriceMinor, overridden };
    }),
  );
  const orderDiscount = input.orderDiscount ?? { kind: 'NONE' as const };
  const discounting =
    orderDiscount.kind === 'AMOUNT'
      ? orderDiscount.amountMinor > 0
      : orderDiscount.kind === 'PCT'
        ? orderDiscount.pct > 0
        : false;
  if (discounting && !canDiscount) {
    throw new ApiError(403, 'FORBIDDEN', 'Discounts need the pos:discount permission', {
      required: ['pos:discount'],
      fields: ['orderDiscount'],
    });
  }

  let computed;
  try {
    computed = computeTotals(
      input.lines.map((line, i) => ({
        unitPriceMinor: priced[i]!.unitPriceMinor,
        qty: stockLines[i]!.qty,
        lineDiscountMinor: line.lineDiscountMinor ?? 0,
      })),
      orderDiscount,
    );
  } catch (error) {
    if (error instanceof PricingError) throw refuse(error.field, error.message);
    throw error;
  }
  // The org's rounding (Day 39): what is charged is the rounded total; the lines stay exact and
  // the difference is recorded on the invoice.
  const step =
    (await Org.findById(actor.orgId).select('settings.roundInvoiceTo').lean())?.settings
      ?.roundInvoiceTo ?? 0;
  const rounded = roundTotal(computed.totalMinor, step);
  const totals = {
    ...computed,
    totalMinor: rounded.totalMinor,
    roundingMinor: rounded.roundingMinor,
  };

  return { party, isDealer, stockLines, productBy, variantLabel, priced, totals };
}

export async function postPosSale(
  actor: RequestActor,
  input: PosSaleInput,
  options: PostSaleOptions = {},
): Promise<PosSaleResult> {
  // ── Idempotency: the till retried a sale that already went through ──
  const earlier = await Invoice.findOne({
    orgId: actor.orgId,
    clientRef: input.clientRef,
  }).lean();
  if (earlier) return replay(actor, earlier);

  // ── The shift ──
  const session = await PosSession.findOne({
    orgId: actor.orgId,
    openedByUserId: actor.actorId,
    status: 'OPEN',
  }).lean();
  if (!session) throw ApiError.conflict('ILLEGAL_TRANSITION', 'Open a shift before selling');
  const locationId = session.locationId;

  const { party, isDealer, stockLines, productBy, variantLabel, priced, totals } =
    await priceCart(actor, input);
  if (input.paymentMode === 'CREDIT' && !isDealer) {
    // An anonymous walk-in, or a counter customer without an account, pays in full.
    throw refuse(
      'paymentMode',
      'Credit is for dealers only — a walk-in or counter customer pays in full',
    );
  }

  // ── Tenders ──
  let tendered;
  try {
    tendered = applyTenders(input.tenders, totals.totalMinor);
  } catch (error) {
    if (error instanceof TenderError) throw refuse('tenders', error.message);
    throw error;
  }
  const { applied, paidMinor, changeMinor } = tendered;
  input.tenders.forEach((t, i) => {
    if (applied[i] === 0)
      throw refuse(
        `tenders.${i}.amountMinor`,
        'Not needed — the other payments already cover the total',
      );
  });
  // Exchange credit: each must be an unspent exchange return, spent whole.
  const exchangeIds = new Set<string>();
  for (const [i, t] of input.tenders.entries()) {
    if (t.method !== 'EXCHANGE') continue;
    if (exchangeIds.has(t.returnId!))
      throw refuse(`tenders.${i}.returnId`, 'This exchange credit is already applied');
    exchangeIds.add(t.returnId!);
    const ret = await SalesReturn.findOne({ _id: t.returnId, orgId: actor.orgId })
      .select('docNo settlement replacementInvoiceId replacementDocNo grandTotalMinor')
      .lean();
    if (!ret || ret.settlement !== 'REPLACEMENT')
      throw refuse(`tenders.${i}.returnId`, 'No such exchange credit');
    if (ret.replacementInvoiceId)
      throw refuse(
        `tenders.${i}.returnId`,
        `${ret.docNo} was already spent on ${ret.replacementDocNo}`,
      );
    if (ret.grandTotalMinor !== t.amountMinor)
      throw refuse(
        `tenders.${i}.amountMinor`,
        `${ret.docNo} is worth ${ret.grandTotalMinor} — it is spent whole`,
      );
  }

  const unpaidMinor = totals.totalMinor - paidMinor;
  if (input.paymentMode === 'CASH' && unpaidMinor > 0) {
    throw refuse('tenders', `Short by ${unpaidMinor} — a cash sale is paid in full`);
  }

  const org = await Org.findById(actor.orgId).select('settings.enforceCreditLimit').lean();
  const now = new Date();
  const termsDays = party?.dealer?.paymentTermsDays ?? 0;
  const dueDate =
    input.paymentMode === 'CREDIT' && unpaidMinor > 0
      ? new Date(now.getTime() + termsDays * 86_400_000)
      : null;

  let invoiceId: Types.ObjectId | undefined;
  const paymentIds: Types.ObjectId[] = [];

  try {
    await withTransaction(async (txn) => {
      paymentIds.length = 0;
      const docNo = await nextDocNo(txn, actor.orgId, 'POS', now);
      invoiceId = new Types.ObjectId();

      // Cost at the moment of sale, per line — what gross margin (Day 37) is measured against.
      const costs = await StockBalance.find({
        orgId: actor.orgId,
        locationId,
        productId: { $in: stockLines.map((l) => l.productId) },
      })
        .select('productId variantId avgCostMinor')
        .session(txn)
        .lean();
      const costOf = (l: StockDocLineDoc) =>
        costs.find(
          (c) =>
            c.productId.equals(l.productId) &&
            String(c.variantId ?? '') === String(l.variantId ?? ''),
        )?.avgCostMinor ?? null;

      const lines: InvoiceLineDoc[] = stockLines.map((l, i) => {
        const p = productBy.get(String(l.productId))!;
        return {
          productId: l.productId,
          variantId: l.variantId,
          description: [p.name, l.variantId ? variantLabel.get(String(l.variantId)) : null]
            .filter(Boolean)
            .join(' — '),
          lotId: null,
          serials: l.serials,
          uomCode: l.uomCode,
          uomQty: l.qty,
          qtyBase: l.qtyBase,
          unitPriceMinor: priced[i]!.unitPriceMinor,
          discountMinor:
            totals.lines[i]!.lineDiscountMinor + totals.lines[i]!.orderDiscountMinor,
          taxPct: 0,
          taxMinor: 0,
          lineTotalMinor: totals.lines[i]!.netMinor,
          costAtSaleMinor: costOf(l),
          priceOverridden: priced[i]!.overridden,
          originalPriceMinor: priced[i]!.overridden ? priced[i]!.resolvedMinor : null,
          qtyReturnedBase: 0,
          returnedSerials: [],
        };
      });

      // Stock first: the most likely refusal (not enough, serial sold) fails before anything else.
      const movements: MovementInput[] = [];
      for (const [i, l] of stockLines.entries()) {
        const tracking = await trackingFor(txn, actor.orgId, l, 'OUT', actor.actorId);
        lines[i]!.lotId = tracking.lotId;
        movements.push({
          locationId,
          productId: l.productId,
          variantId: l.variantId,
          qtyBase: -l.qtyBase,
          movementType: 'SALE',
          refType: 'INVOICE',
          refId: invoiceId,
          refDocNo: docNo,
          unitCostMinor: lines[i]!.costAtSaleMinor,
          ...tracking,
          sale: {
            partyId: party?._id ?? null,
            invoiceId,
            sellPriceMinor: Math.round(lines[i]!.lineTotalMinor / l.qtyBase),
          },
        });
      }
      await postMovements(txn, {
        orgId: actor.orgId,
        movements,
        postedAt: now,
        actorId: actor.actorId,
      });

      await Invoice.create(
        [
          {
            _id: invoiceId,
            orgId: actor.orgId,
            docNo,
            series: 'POS',
            channel: 'COUNTER',
            partyId: party?._id ?? null,
            walkInName: party ? null : (input.walkInName ?? null),
            walkInPhone: input.walkInPhone ?? null,
            partySnapshot: party
              ? {
                  name: party.displayName ?? party.name,
                  phone: party.phone ?? null,
                  address: party.addresses?.find((a) => a.isDefaultBilling)?.line1 ?? null,
                  tin: party.tin ?? null,
                  bin: party.bin ?? null,
                }
              : null,
            locationId,
            posSessionId: session._id,
            invoiceDate: now,
            dueDate,
            paymentTermsDays: input.paymentMode === 'CREDIT' ? termsDays : 0,
            status: 'POSTED',
            lines,
            subtotalMinor: totals.grossMinor,
            discountMinor: totals.lineDiscountMinor + totals.orderDiscountMinor,
            taxMinor: 0,
            roundingMinor: totals.roundingMinor,
            grandTotalMinor: totals.totalMinor,
            paidMinor,
            balanceMinor: unpaidMinor,
            paymentStatus: unpaidMinor === 0 ? 'PAID' : paidMinor === 0 ? 'UNPAID' : 'PARTIAL',
            salespersonUserId: actor.actorId,
            clientRef: input.clientRef,
            note: input.note ?? null,
            postedAt: now,
            postedBy: actor.actorId,
            createdBy: actor.actorId,
            updatedBy: actor.actorId,
          },
        ],
        { session: txn },
      );

      // One numbered receipt per tender, each allocated in full to this invoice.
      for (const [i, t] of input.tenders.entries()) {
        const amountMinor = applied[i]!;
        const rcpt = await nextDocNo(txn, actor.orgId, 'RCPT', now);
        const [pay] = await PaymentDoc.create(
          [
            {
              orgId: actor.orgId,
              docNo: rcpt,
              series: 'RCPT',
              direction: 'IN',
              partyId: party?._id ?? null,
              locationId,
              posSessionId: session._id,
              paidAt: now,
              // An exchange moves value from a return to this sale — no money changes hands.
              method: t.method === 'EXCHANGE' ? 'ADJUSTMENT' : t.method,
              amountMinor,
              allocatedMinor: amountMinor,
              unallocatedMinor: 0,
              allocations: [
                { invoiceId, docNo, amountMinor, allocatedAt: now, allocatedBy: actor.actorId },
              ],
              instrument: t.cheque
                ? {
                    chequeNo: t.cheque.chequeNo,
                    bankName: t.cheque.bankName ?? null,
                    chequeDate: t.cheque.chequeDate ? new Date(t.cheque.chequeDate) : null,
                    status: 'PENDING',
                  }
                : null,
              mfs: t.mfs
                ? {
                    provider: t.mfs.provider,
                    trxId: t.mfs.trxId,
                    senderNumber: t.mfs.senderNumber ?? null,
                  }
                : null,
              collectedByUserId: actor.actorId,
              narration:
                t.method === 'EXCHANGE'
                  ? `Exchange credit ${t.returnId}`
                  : (t.reference ?? null),
              createdBy: actor.actorId,
              updatedBy: actor.actorId,
            },
          ],
          { session: txn },
        );
        paymentIds.push(pay!._id);

        if (t.method === 'EXCHANGE') {
          // Spend the credit — conditionally, so two sales cannot both spend one return.
          const spent = await SalesReturn.updateOne(
            {
              _id: t.returnId,
              orgId: actor.orgId,
              settlement: 'REPLACEMENT',
              replacementInvoiceId: null,
            },
            { $set: { replacementInvoiceId: invoiceId, replacementDocNo: docNo } },
            { session: txn },
          );
          if (spent.modifiedCount !== 1) {
            throw ApiError.conflict(
              'ILLEGAL_TRANSITION',
              'That exchange credit has just been used',
            );
          }
        }
      }

      // Credit: the dealer's account takes the invoice, less what was paid now — checked against
      // the balance as it stands inside this transaction, not as it looked before it began.
      if (input.paymentMode === 'CREDIT' && party) {
        if (unpaidMinor > 0) {
          const fresh = await Party.findById(party._id).select('dealer').session(txn).lean();
          // The full exposure (Day 31): a dealer cannot step round their limit at the counter
          // while confirmed orders wait in the warehouse.
          // This sale's invoice is already written in this transaction; it is the new credit
          // being judged, so it must not also count as an open invoice.
          const exposure = await creditExposure(actor.orgId, party._id, {
            session: txn,
            excludeInvoiceId: invoiceId,
          });
          const verdict = checkCredit(
            {
              creditHold: Boolean(fresh?.dealer?.creditHold),
              creditHoldReason: fresh?.dealer?.creditHoldReason ?? null,
              creditLimitMinor: fresh?.dealer?.creditLimitMinor ?? 0,
              exposureMinor: exposure.exposureMinor,
            },
            unpaidMinor,
            Boolean(org?.settings?.enforceCreditLimit),
          );
          if (!verdict.ok) {
            throw ApiError.conflict('CREDIT_LIMIT_EXCEEDED', verdict.message, {
              reason: verdict.reason,
              exposureAfterMinor: verdict.exposureAfterMinor,
              limitMinor: verdict.limitMinor,
            });
          }
        }
        await postLedgerEntries(txn, {
          orgId: actor.orgId,
          postedAt: now,
          actorId: actor.actorId,
          entries: [
            {
              partyId: party._id,
              docType: 'INVOICE',
              refType: 'INVOICE',
              refId: invoiceId,
              refDocNo: docNo,
              debitMinor: totals.totalMinor,
              dueDate,
              narration: 'Counter sale on credit',
            },
            ...input.tenders.map((t, i) => ({
              partyId: party._id,
              docType: 'RECEIPT' as const,
              refType: 'PAYMENT',
              refId: paymentIds[i]!,
              refDocNo: docNo,
              creditMinor: applied[i]!,
              narration: `Paid at the counter (${t.method.toLowerCase()})`,
            })),
          ],
        });
      }

      if (input.heldSaleId) {
        await HeldSale.deleteOne(
          { _id: input.heldSaleId, orgId: actor.orgId, posSessionId: session._id },
          { session: txn },
        );
      }

      await options.beforeCommit?.();
    });
  } catch (error) {
    // Two submissions of the same sale raced past the idempotency check together: the unique
    // index let exactly one commit. Hand the other the sale that won.
    if (
      error instanceof mongo.MongoServerError &&
      error.code === 11000 &&
      String(error.message).includes('invoice_client_ref_unique')
    ) {
      const winner = await Invoice.findOne({
        orgId: actor.orgId,
        clientRef: input.clientRef,
      }).lean();
      if (winner) return replay(actor, winner);
    }
    throw error;
  }

  const [invoice, payments] = await Promise.all([
    Invoice.findById(invoiceId).lean(),
    PaymentDoc.find({ _id: { $in: paymentIds } })
      .sort({ docNo: 1 })
      .lean(),
  ]);
  return {
    invoice: await invoicePayload(invoice!),
    payments: payments.map(paymentPayload),
    changeMinor,
    replayed: false,
  };
}

/** A posted counter sale and its receipts — for the receipt reprint. */
export async function getPosSale(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<PosSaleResult> {
  const invoice = await Invoice.findOne({
    _id: id,
    orgId: actor.orgId,
    channel: 'COUNTER',
  }).lean();
  if (!invoice) throw ApiError.notFound('Sale');
  return { ...(await replay(actor, invoice)), replayed: false };
}

/**
 * `POST /pos/quote` — price the cart exactly as the sale would, and write nothing.
 *
 * The till calls it as the cart changes, so every figure on the screen is the server's. It also
 * reports what is on hand at the cashier's counter, so "only 3 left" is visible before the sale is
 * refused — and which lines still need a serial or a lot scanned.
 */
export async function quotePosCart(actor: RequestActor, input: CartInput): Promise<PosQuote> {
  const { party, isDealer, stockLines, productBy, variantLabel, priced, totals } =
    await priceCart(actor, input, {
      requireCapture: false,
    });

  const session = await PosSession.findOne({
    orgId: actor.orgId,
    openedByUserId: actor.actorId,
    status: 'OPEN',
  })
    .select('locationId')
    .lean();
  const balances = session
    ? await StockBalance.find({
        orgId: actor.orgId,
        locationId: session.locationId,
        productId: { $in: stockLines.map((l) => l.productId) },
      })
        .select('productId variantId qtyOnHand qtyReserved')
        .lean()
    : [];

  return {
    lines: stockLines.map((l, i) => {
      const p = productBy.get(String(l.productId))!;
      const bal = balances.find(
        (b) =>
          b.productId.equals(l.productId) &&
          String(b.variantId ?? '') === String(l.variantId ?? ''),
      );
      const needs =
        p.trackingMode === 'SERIAL' && l.serials.length !== l.qtyBase
          ? ('SERIALS' as const)
          : p.trackingMode === 'LOT' && !l.lotNo
            ? ('LOT' as const)
            : null;
      return {
        productId: String(l.productId),
        variantId: l.variantId ? String(l.variantId) : null,
        description: [p.name, l.variantId ? variantLabel.get(String(l.variantId)) : null]
          .filter(Boolean)
          .join(' — '),
        sku: p.sku,
        trackingMode: p.trackingMode,
        uomCode: l.uomCode,
        qty: l.qty,
        qtyBase: l.qtyBase,
        unitPriceMinor: priced[i]!.unitPriceMinor,
        resolvedPriceMinor: priced[i]!.resolvedMinor,
        priceOverridden: priced[i]!.overridden,
        lineDiscountMinor: totals.lines[i]!.lineDiscountMinor,
        orderDiscountMinor: totals.lines[i]!.orderDiscountMinor,
        lineTotalMinor: totals.lines[i]!.netMinor,
        availableBase: session ? (bal ? bal.qtyOnHand - bal.qtyReserved : 0) : null,
        needs,
      };
    }),
    grossMinor: totals.grossMinor,
    discountMinor: totals.lineDiscountMinor + totals.orderDiscountMinor,
    roundingMinor: totals.roundingMinor,
    totalMinor: totals.totalMinor,
    customer: party
      ? {
          id: String(party._id),
          name: party.displayName ?? party.name,
          isDealer,
          balanceMinor: party.currentBalanceMinor,
        }
      : null,
  };
}
