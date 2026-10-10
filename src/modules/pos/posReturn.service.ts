import { mongo, Types } from 'mongoose';

import { returnValueMinor } from '../../domain/returns.js';
import { ApiError } from '../../lib/ApiError.js';
import { listQuerySchema, paginate } from '../../lib/paginate.js';
import { nextDocNo } from '../../lib/numbering.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { postMovements } from '../../services/stock.service.js';
import { Invoice } from '../invoice/invoice.model.js';
import { LedgerEntry } from '../ledger/ledgerEntry.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';
import { Product } from '../product/product.model.js';
import { raiseCreditNote } from '../salesReturn/creditNote.service.js';
import { SalesReturn, toSalesReturnPayload } from '../salesReturn/salesReturn.model.js';

import { PosSession } from './posSession.model.js';
import { invoicePayload } from './posSale.service.js';

import type { InvoiceDoc } from '../invoice/invoice.model.js';
import type { SalesReturnDoc, SalesReturnLineDoc } from '../salesReturn/salesReturn.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { MovementInput } from '../../services/stock.service.js';
import type { CounterReturnInput, CounterReturnSettlement } from '@shared/pos.js';
import type { PageMeta, ReturnableInvoice, SalesReturnPayload } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';
import type { z } from 'zod';

/**
 * Counter returns (Day 20) — goods back against a POS invoice, in one transaction:
 *
 *   `SALE_RETURN` stock in at the counter (a DAMAGED unit is written off with `DAMAGE` in the same
 *   posting) → the invoice's returned quantities → the money: cash out of the drawer, a credit on
 *   the dealer's account, or an exchange credit the next sale spends.
 *
 * How it may settle depends on how the sale was paid. A sale that went on a dealer's account
 * (it has ledger entries) settles as a credit note or — up to what was actually paid — a cash
 * refund. A sale paid in full at the counter settles as a cash refund or an exchange.
 */

const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

type Line = InvoiceDoc['lines'][number] & { _id: Types.ObjectId };

async function openSessionOf(actor: RequestActor) {
  const session = await PosSession.findOne({
    orgId: actor.orgId,
    openedByUserId: actor.actorId,
    status: 'OPEN',
  }).lean();
  if (!session)
    throw ApiError.conflict('ILLEGAL_TRANSITION', 'Open a shift before taking returns');
  return session;
}

/** Did this counter sale go on a dealer's account? Then its return must go through the ledger. */
async function isOnAccount(orgId: Types.ObjectId, invoice: InvoiceDoc): Promise<boolean> {
  if (!invoice.partyId) return false;
  return Boolean(
    await LedgerEntry.exists({
      orgId,
      refType: 'INVOICE',
      refId: invoice._id,
      docType: 'INVOICE',
    }),
  );
}

const settlementsFor = (onAccount: boolean): CounterReturnSettlement[] =>
  onAccount ? ['CREDIT_NOTE', 'CASH_REFUND'] : ['CASH_REFUND', 'REPLACEMENT'];

async function findCounterInvoice(
  orgId: Types.ObjectId,
  by: { id?: Types.ObjectId; docNo?: string },
  session?: ClientSession,
) {
  const filter: FilterQuery<InvoiceDoc> = { orgId, channel: 'COUNTER', status: 'POSTED' };
  if (by.id) filter._id = by.id;
  else filter.docNo = by.docNo!.trim().toUpperCase();
  const q = Invoice.findOne(filter);
  if (session) q.session(session);
  const invoice = await q.lean();
  if (!invoice) throw ApiError.notFound('Counter sale');
  return invoice;
}

/** `GET /pos/returns/invoice?docNo=` — a receipt, as the returns screen needs it. */
export async function getReturnableInvoice(
  actor: RequestActor,
  by: { id?: Types.ObjectId; docNo?: string },
): Promise<ReturnableInvoice> {
  const invoice = await findCounterInvoice(actor.orgId, by);
  const [onAccount, products, previous] = await Promise.all([
    isOnAccount(actor.orgId, invoice),
    Product.find({ _id: { $in: invoice.lines.map((l) => l.productId) } })
      .select('trackingMode baseUom')
      .lean(),
    SalesReturn.find({ orgId: actor.orgId, invoiceId: invoice._id })
      .sort({ postedAt: 1 })
      .lean(),
  ]);
  return {
    invoice: await invoicePayload(invoice),
    returnable: (invoice.lines as Line[]).map((l) => {
      const p = products.find((x) => x._id.equals(l.productId));
      const returned = new Set(l.returnedSerials ?? []);
      return {
        invoiceLineId: String(l._id),
        qtyBase: l.qtyBase - (l.qtyReturnedBase ?? 0),
        serials: l.serials.filter((s) => !returned.has(s)),
        trackingMode: p?.trackingMode ?? 'NONE',
        baseUom: p?.baseUom ?? l.uomCode,
      };
    }),
    settlements: settlementsFor(onAccount),
    previousReturns: previous.map(toSalesReturnPayload),
  };
}

/**
 * Check the requested lines against the invoice as it stands, and price them. Run before the
 * transaction for a quick refusal and again inside it against the invoice read in the
 * transaction — the second one is the one that counts.
 */
function planLines(invoice: InvoiceDoc, input: CounterReturnInput) {
  const byId = new Map((invoice.lines as Line[]).map((l) => [String(l._id), l]));
  const seen = new Set<string>();
  return input.lines.map((r, i) => {
    const line = byId.get(r.invoiceLineId);
    if (!line) throw refuse(`lines.${i}.invoiceLineId`, 'Not a line of this sale');
    if (seen.has(r.invoiceLineId))
      throw refuse(`lines.${i}.invoiceLineId`, 'This line appears twice');
    seen.add(r.invoiceLineId);

    const left = line.qtyBase - (line.qtyReturnedBase ?? 0);
    if (r.qtyBase > left) {
      throw refuse(
        `lines.${i}.qtyBase`,
        left === 0
          ? `${line.description} has already been returned in full`
          : `Only ${left} of ${line.description} can still come back`,
      );
    }

    let serials: string[] = [];
    if (line.serials.length > 0) {
      serials = [...new Set(r.serials ?? [])];
      if (serials.length !== r.qtyBase) {
        throw refuse(`lines.${i}.serials`, `Name the ${r.qtyBase} serial(s) coming back`);
      }
      const returned = new Set(line.returnedSerials ?? []);
      for (const sn of serials) {
        if (!line.serials.includes(sn))
          throw refuse(`lines.${i}.serials`, `${sn} was not sold on this invoice`);
        if (returned.has(sn)) throw refuse(`lines.${i}.serials`, `${sn} has already come back`);
      }
    }

    const value = returnValueMinor(
      {
        lineTotalMinor: line.lineTotalMinor,
        qtyBase: line.qtyBase,
        qtyReturnedBase: line.qtyReturnedBase ?? 0,
      },
      r.qtyBase,
    );
    return { line, input: r, serials, value };
  });
}

export interface PostReturnOptions {
  /** Test-only fault injection, as on the sale. */
  beforeCommit?: () => Promise<void> | void;
}

export async function postCounterReturn(
  actor: RequestActor,
  input: CounterReturnInput,
  options: PostReturnOptions = {},
): Promise<{ salesReturn: SalesReturnPayload; replayed: boolean }> {
  const earlier = await SalesReturn.findOne({
    orgId: actor.orgId,
    clientRef: input.clientRef,
  }).lean();
  if (earlier) return { salesReturn: toSalesReturnPayload(earlier), replayed: true };

  const session = await openSessionOf(actor);
  const invoice = await findCounterInvoice(actor.orgId, {
    id: new Types.ObjectId(input.invoiceId),
  });
  const onAccount = await isOnAccount(actor.orgId, invoice);
  if (!settlementsFor(onAccount).includes(input.settlement)) {
    throw refuse(
      'settlement',
      onAccount
        ? 'This sale went on the dealer’s account — settle it as a credit note or a refund'
        : 'This sale was paid at the counter — refund it or exchange it',
    );
  }
  planLines(invoice, input); // fail fast, before any lock is taken

  const now = new Date();
  const returnId = new Types.ObjectId();

  try {
    await withTransaction(async (txn) => {
      // Re-read inside the transaction: this read, and the write to the same invoice below, are
      // what make two returns racing for one line conflict instead of both succeeding.
      const current = await findCounterInvoice(actor.orgId, { id: invoice._id }, txn);
      const plan = planLines(current, input);
      const totalMinor = plan.reduce((s, p) => s + p.value, 0);

      if (input.settlement === 'CASH_REFUND' && onAccount) {
        // Money back only for money received — the unpaid part is a credit, not cash.
        const paidNow = current.paidMinor;
        if (totalMinor > paidNow) {
          throw refuse(
            'settlement',
            `Only ${paidNow} was paid on this sale — settle the rest as a credit note`,
          );
        }
      }

      const docNo = await nextDocNo(txn, actor.orgId, 'SR', now);
      const locationId = session.locationId;

      // ── Stock ──
      const movements: MovementInput[] = [];
      const lines: SalesReturnLineDoc[] = [];
      for (const p of plan) {
        const base = {
          locationId,
          productId: p.line.productId,
          variantId: p.line.variantId,
          refType: 'SALES_RETURN',
          refId: returnId,
          refDocNo: docNo,
          lotId: p.line.lotId,
          ...(p.serials.length ? { serials: p.serials } : {}),
        };
        movements.push({
          ...base,
          qtyBase: p.input.qtyBase,
          movementType: 'SALE_RETURN',
          unitCostMinor: p.line.costAtSaleMinor,
        });
        if (p.input.condition === 'DAMAGED') {
          movements.push({
            ...base,
            qtyBase: -p.input.qtyBase,
            movementType: 'DAMAGE',
            narration: `Returned damaged on ${docNo}`,
          });
        }
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
          restock: p.input.condition === 'GOOD',
          restockLocationId: locationId,
        });
      }
      await postMovements(txn, {
        orgId: actor.orgId,
        movements,
        postedAt: now,
        actorId: actor.actorId,
      });

      // ── The invoice remembers what came back ──
      // Refund and exchange hand the money back (paid goes down, credited up). A credit note
      // leaves the money here alone: it is a document of its own (Day 36), allocated below.
      const cashBack = input.settlement !== 'CREDIT_NOTE';
      const paidMinor = cashBack ? current.paidMinor - totalMinor : current.paidMinor;
      const creditedMinor = (current.creditedMinor ?? 0) + (cashBack ? totalMinor : 0);
      const balanceMinor = Math.max(0, current.grandTotalMinor - paidMinor - creditedMinor);
      const inc: Record<string, number> = {};
      const push: Record<string, { $each: string[] }> = {};
      const arrayFilters = plan.map((p, i) => {
        inc[`lines.$[l${i}].qtyReturnedBase`] = p.input.qtyBase;
        if (p.serials.length) push[`lines.$[l${i}].returnedSerials`] = { $each: p.serials };
        return { [`l${i}._id`]: p.line._id };
      });
      await Invoice.updateOne(
        { _id: current._id, orgId: actor.orgId },
        {
          $inc: inc,
          ...(Object.keys(push).length ? { $push: push } : {}),
          $set: {
            paidMinor,
            creditedMinor,
            balanceMinor,
            paymentStatus: balanceMinor === 0 ? 'PAID' : paidMinor > 0 ? 'PARTIAL' : 'UNPAID',
            updatedBy: actor.actorId,
          },
        },
        { arrayFilters, session: txn },
      );

      // ── The money ──
      let refundPaymentId: Types.ObjectId | null = null;
      let refundDocNo: string | null = null;
      let creditNoteDocNo: string | null = null;

      if (input.settlement === 'CASH_REFUND') {
        ({ refundPaymentId, refundDocNo } = await postRefund(txn, actor, {
          amountMinor: totalMinor,
          partyId: current.partyId,
          locationId,
          posSessionId: session._id,
          at: now,
          narration: `Refund on ${docNo} for ${current.docNo}`,
        }));
      }
      let creditNoteId: Types.ObjectId | null = null;
      if (input.settlement === 'CREDIT_NOTE') {
        // Raised as a credit note document — its own ledger CREDIT, allocated by default to this
        // sale as far as it is still owed; any rest stays open for the dealer's next invoice.
        const cn = await raiseCreditNote(txn, actor, {
          channel: 'COUNTER',
          partyId: current.partyId!,
          salesReturnId: returnId,
          salesReturnDocNo: docNo,
          invoiceId: current._id,
          invoiceDocNo: current.docNo!,
          amountMinor: totalMinor,
          at: now,
          narration: `Counter return ${docNo} against ${current.docNo}`,
        });
        creditNoteDocNo = cn.docNo;
        creditNoteId = cn._id;
      }
      if (onAccount && current.partyId && input.settlement !== 'CREDIT_NOTE') {
        // The account is credited with the goods; a cash refund then pays that credit out.
        await postLedgerEntries(txn, {
          orgId: actor.orgId,
          postedAt: now,
          actorId: actor.actorId,
          entries: [
            {
              partyId: current.partyId,
              docType: 'CREDIT_NOTE',
              refType: 'SALES_RETURN',
              refId: returnId,
              refDocNo: docNo,
              creditMinor: totalMinor,
              narration: `Counter return ${docNo} against ${current.docNo}`,
            },
            ...(refundPaymentId
              ? [
                  {
                    partyId: current.partyId,
                    docType: 'PAYMENT' as const,
                    refType: 'PAYMENT',
                    refId: refundPaymentId,
                    refDocNo: refundDocNo!,
                    debitMinor: totalMinor,
                    narration: `Cash refunded at the counter on ${docNo}`,
                  },
                ]
              : []),
          ],
        });
      }

      await SalesReturn.create(
        [
          {
            _id: returnId,
            orgId: actor.orgId,
            docNo,
            channel: 'COUNTER',
            invoiceId: current._id,
            invoiceDocNo: current.docNo!,
            partyId: current.partyId,
            customerName: current.partySnapshot?.name ?? current.walkInName ?? null,
            locationId,
            posSessionId: session._id,
            returnDate: now,
            reason: input.reason,
            status: 'POSTED',
            lines,
            subtotalMinor: totalMinor,
            taxMinor: 0,
            grandTotalMinor: totalMinor,
            settlement: input.settlement,
            creditNoteDocNo,
            creditNoteId,
            refundPaymentId,
            refundDocNo,
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

      await options.beforeCommit?.();
    });
  } catch (error) {
    if (
      error instanceof mongo.MongoServerError &&
      error.code === 11000 &&
      String(error.message).includes('sales_return_client_ref_unique')
    ) {
      const winner = await SalesReturn.findOne({
        orgId: actor.orgId,
        clientRef: input.clientRef,
      }).lean();
      if (winner) return { salesReturn: toSalesReturnPayload(winner), replayed: true };
    }
    throw error;
  }

  const saved = await SalesReturn.findById(returnId).lean();
  return { salesReturn: toSalesReturnPayload(saved!), replayed: false };
}

/** Cash out of the drawer — a numbered `PAY` document on the shift, which the Z-report nets off. */
async function postRefund(
  txn: ClientSession,
  actor: RequestActor,
  args: {
    amountMinor: number;
    partyId: Types.ObjectId | null;
    locationId: Types.ObjectId;
    posSessionId: Types.ObjectId;
    at: Date;
    narration: string;
  },
): Promise<{ refundPaymentId: Types.ObjectId; refundDocNo: string }> {
  const refundDocNo = await nextDocNo(txn, actor.orgId, 'PAY', args.at);
  const [pay] = await PaymentDoc.create(
    [
      {
        orgId: actor.orgId,
        docNo: refundDocNo,
        series: 'PAY',
        direction: 'OUT',
        partyId: args.partyId,
        locationId: args.locationId,
        posSessionId: args.posSessionId,
        paidAt: args.at,
        method: 'CASH',
        amountMinor: args.amountMinor,
        allocatedMinor: 0,
        unallocatedMinor: 0,
        isRefund: true,
        collectedByUserId: actor.actorId,
        narration: args.narration,
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      },
    ],
    { session: txn },
  );
  return { refundPaymentId: pay!._id, refundDocNo };
}

/**
 * An exchange whose credit was never spent — the customer changed their mind and wants the money.
 * Turns it into a cash refund from the current shift's drawer.
 */
export async function refundExchangeCredit(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<SalesReturnPayload> {
  const session = await openSessionOf(actor);
  const now = new Date();
  await withTransaction(async (txn) => {
    const ret = await SalesReturn.findOne({ _id: id, orgId: actor.orgId }).session(txn).lean();
    if (!ret) throw ApiError.notFound('Return');
    if (ret.settlement !== 'REPLACEMENT')
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'This return was not settled as an exchange',
      );
    if (ret.replacementInvoiceId)
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        `This credit was already spent on ${ret.replacementDocNo}`,
      );
    const { refundPaymentId, refundDocNo } = await postRefund(txn, actor, {
      amountMinor: ret.grandTotalMinor,
      partyId: ret.partyId,
      locationId: session.locationId,
      posSessionId: session._id,
      at: now,
      narration: `Refund of unused exchange credit ${ret.docNo}`,
    });
    const res = await SalesReturn.updateOne(
      { _id: id, orgId: actor.orgId, settlement: 'REPLACEMENT', replacementInvoiceId: null },
      {
        $set: {
          settlement: 'CASH_REFUND',
          refundPaymentId,
          refundDocNo,
          updatedBy: actor.actorId,
        },
      },
      { session: txn },
    );
    if (res.modifiedCount !== 1)
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'This credit has just been used');
  });
  return toSalesReturnPayload((await SalesReturn.findById(id).lean())!);
}

export async function getReturn(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<SalesReturnPayload> {
  const doc = await SalesReturn.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Return');
  return toSalesReturnPayload(doc);
}

export const listReturnsQuerySchema = listQuerySchema;

/** Recent counter returns — by default the caller's current shift. */
export async function listReturns(
  actor: RequestActor,
  query: z.infer<typeof listReturnsQuerySchema> & {
    posSessionId?: string;
    openExchange?: boolean;
  },
): Promise<{ items: SalesReturnPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<SalesReturnDoc> = { orgId: actor.orgId, channel: 'COUNTER' };
  if (query.posSessionId) filter.posSessionId = new Types.ObjectId(query.posSessionId);
  if (query.openExchange) {
    filter.settlement = 'REPLACEMENT';
    filter.replacementInvoiceId = null;
  }
  const { items, meta } = await paginate<SalesReturnDoc>(SalesReturn, {
    filter,
    query,
    sortable: ['postedAt', 'docNo'],
    searchFields: ['docNo', 'invoiceDocNo', 'customerName'],
    defaultSort: { postedAt: -1 },
  });
  return { items: items.map(toSalesReturnPayload), meta };
}
