import { Types } from 'mongoose';

import {
  fifoOrder,
  paymentStatusOf,
  proposeFifo,
  validateAllocations,
} from '../../domain/allocation.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { GoodsReceipt } from '../goodsReceipt/goodsReceipt.model.js';
import { Party } from '../party/party.model.js';
import { PurchaseReturn } from '../purchaseReturn/purchaseReturn.model.js';

import { PaymentDoc } from './paymentDoc.model.js';

import type { ListSupplierPaymentsQuery } from './payment.schema.js';
import type { AllocationDoc, PaymentDocDoc } from './paymentDoc.model.js';
import type { Allocation, AllocationProblem, OpenInvoice } from '../../domain/allocation.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { GoodsReceiptDoc } from '../goodsReceipt/goodsReceipt.model.js';
import type {
  AllocateSupplierPaymentInput,
  AllocationPreviewQuery,
  PayableAllocationInput,
  SupplierPaymentInput,
} from '@shared/payments.js';
import type {
  OpenPayablePayload,
  PageMeta,
  PayablesPreview,
  SupplierPaymentPayload,
  SupplierPaymentResult,
} from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Supplier payments — Day 35. A receipt the other way round, through the same machinery:
 *
 *   1. a `PAY` number;
 *   2. the allocation — explicit, or oldest-due-first (`domain/allocation`) — validated against
 *      the supplier's **open bills**: posted goods receipts with a balance, as they are *now*;
 *   3. per bill: `$inc paidMinor`, `$inc balanceMinor` by the negative, guarded so a bill can never
 *      be paid past zero, and its payment status recomputed;
 *   4. the payment, with whatever was not allocated left on it as an advance to the supplier;
 *   5. ONE debit to the supplier's ledger for the whole amount — we owe them that much less.
 *
 * A supplier's balance is negative while we owe them (their bills are credits); a payment debits
 * it back towards zero.
 */

const DAY = 86_400_000;
const refuse = (problems: AllocationProblem[]) =>
  ApiError.validation('Validation failed', problems);

/** The allocation grid speaks `grnId`; the shared machinery speaks `invoiceId`. */
const toPlan = (a: readonly PayableAllocationInput[]): Allocation[] =>
  a.map((x) => ({ invoiceId: x.grnId, amountMinor: x.amountMinor }));
const fromProblems = (problems: AllocationProblem[]) =>
  problems.map((p) => ({ ...p, path: p.path.replace(/\.invoiceId$/, '.grnId') }));

// ─── Open bills ─────────────────────────────────────────────────────────────────────────

async function openPayableDocs(
  orgId: Types.ObjectId,
  partyId: Types.ObjectId,
  session?: ClientSession,
): Promise<GoodsReceiptDoc[]> {
  return GoodsReceipt.find({
    orgId,
    supplierPartyId: partyId,
    status: 'POSTED',
    balanceMinor: { $gt: 0 },
  })
    .session(session ?? null)
    .lean();
}

/** A bill is dated by the supplier's bill date, else by when the goods arrived. */
const asOpen = (g: GoodsReceiptDoc): OpenInvoice => ({
  id: String(g._id),
  docNo: g.docNo ?? '',
  invoiceDate: g.supplierInvoiceDate ?? g.receivedAt,
  dueDate: g.dueDate,
  balanceMinor: g.balanceMinor,
});

function openPayload(g: GoodsReceiptDoc, now: Date): OpenPayablePayload {
  return {
    id: String(g._id),
    docNo: g.docNo ?? '',
    supplierInvoiceNo: g.supplierInvoiceNo,
    billDate: (g.supplierInvoiceDate ?? g.receivedAt).toISOString(),
    dueDate: g.dueDate ? g.dueDate.toISOString() : null,
    grandTotalMinor: g.grandTotalMinor,
    paidMinor: g.paidMinor,
    creditedMinor: g.creditedMinor ?? 0,
    balanceMinor: g.balanceMinor,
    daysOverdue: g.dueDate ? Math.floor((now.getTime() - g.dueDate.getTime()) / DAY) : null,
  };
}

async function loadSupplier(actor: RequestActor, partyId: string) {
  const party = await Party.findOne({ _id: partyId, orgId: actor.orgId })
    .select('name displayName code roles')
    .lean();
  if (!party || !party.roles.includes('SUPPLIER')) {
    throw refuse([{ path: 'partyId', message: 'No such supplier' }]);
  }
  return party;
}

/** Settle bills, inside the caller's transaction — each `$inc` guarded by what is left on it. */
async function settleBills(
  session: ClientSession,
  orgId: Types.ObjectId,
  plan: readonly Allocation[],
): Promise<SupplierPaymentResult['payables']> {
  const out: SupplierPaymentResult['payables'] = [];
  for (const a of plan) {
    const g = await GoodsReceipt.findOneAndUpdate(
      {
        _id: new Types.ObjectId(a.invoiceId),
        orgId,
        status: 'POSTED',
        balanceMinor: { $gte: a.amountMinor },
      },
      { $inc: { paidMinor: a.amountMinor, balanceMinor: -a.amountMinor } },
      { new: true, session },
    ).lean();
    if (!g) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'A bill was paid by another payment meanwhile — reload the allocation and try again',
        { grnId: a.invoiceId },
      );
    }
    const paymentStatus = paymentStatusOf(g.grandTotalMinor, g.paidMinor, g.creditedMinor ?? 0);
    if (paymentStatus !== g.paymentStatus) {
      await GoodsReceipt.updateOne({ _id: g._id }, { $set: { paymentStatus } }, { session });
    }
    out.push({
      id: String(g._id),
      docNo: g.docNo ?? '',
      balanceMinor: g.balanceMinor,
      paymentStatus,
    });
  }
  return out;
}

const allocationDocs = (
  plan: readonly Allocation[],
  docNoOf: Map<string, string>,
  at: Date,
  by: Types.ObjectId,
): Omit<AllocationDoc, '_id'>[] =>
  plan.map((a) => ({
    kind: 'GRN' as const,
    invoiceId: new Types.ObjectId(a.invoiceId),
    docNo: docNoOf.get(a.invoiceId) ?? '',
    amountMinor: a.amountMinor,
    allocatedAt: at,
    allocatedBy: by,
    reversedAt: null,
  }));

// ─── Wire shape ─────────────────────────────────────────────────────────────────────────

async function serialize(
  orgId: Types.ObjectId,
  docs: PaymentDocDoc[],
): Promise<SupplierPaymentPayload[]> {
  const parties = await Party.find({ orgId, _id: { $in: docs.map((d) => d.partyId) } })
    .select('name displayName code')
    .lean();
  const by = new Map(
    parties.map((p) => [String(p._id), { name: p.displayName ?? p.name, code: p.code }]),
  );
  return docs.map((p) => ({
    id: String(p._id),
    docNo: p.docNo,
    partyId: String(p.partyId),
    partyName: by.get(String(p.partyId))?.name,
    partyCode: by.get(String(p.partyId))?.code,
    paidAt: p.paidAt.toISOString(),
    method: p.method,
    amountMinor: p.amountMinor,
    allocatedMinor: p.allocatedMinor,
    unallocatedMinor: p.unallocatedMinor,
    allocations: p.allocations
      .filter((a) => !a.reversedAt)
      .map((a) => ({
        grnId: String(a.invoiceId),
        docNo: a.docNo,
        amountMinor: a.amountMinor,
        allocatedAt: a.allocatedAt.toISOString(),
      })),
    reference: p.reference ?? null,
    mfs: p.mfs
      ? {
          provider: p.mfs.provider,
          trxId: p.mfs.trxId,
          senderNumber: p.mfs.senderNumber ?? null,
        }
      : null,
    narration: p.narration,
    status: p.status,
    paidByUserId: p.collectedByUserId ? String(p.collectedByUserId) : null,
    createdAt: p.createdAt.toISOString(),
  }));
}

// ─── Preview ────────────────────────────────────────────────────────────────────────────

/** `GET /payments/payables-preview` — what oldest-due-first would do with this much money. */
export async function payablesPreview(
  actor: RequestActor,
  query: AllocationPreviewQuery,
): Promise<PayablesPreview> {
  await loadSupplier(actor, query.partyId);
  const partyId = new Types.ObjectId(query.partyId);
  const [docs, advance, returns] = await Promise.all([
    openPayableDocs(actor.orgId, partyId),
    PaymentDoc.aggregate<{ n: number }>([
      {
        $match: {
          orgId: actor.orgId,
          partyId,
          direction: 'OUT',
          status: 'POSTED',
          unallocatedMinor: { $gt: 0 },
        },
      },
      { $group: { _id: null, n: { $sum: '$unallocatedMinor' } } },
    ]),
    PurchaseReturn.aggregate<{ n: number }>([
      { $match: { orgId: actor.orgId, supplierPartyId: partyId, unappliedMinor: { $gt: 0 } } },
      { $group: { _id: null, n: { $sum: '$unappliedMinor' } } },
    ]),
  ]);
  const open = docs.map(asOpen);
  const plan = proposeFifo(open, query.amountMinor);
  const docNoOf = new Map(open.map((o) => [o.id, o.docNo]));
  const now = new Date();
  return {
    partyId: query.partyId,
    amountMinor: query.amountMinor,
    openPayables: [...docs]
      .sort((a, b) => fifoOrder(asOpen(a), asOpen(b)))
      .map((d) => openPayload(d, now)),
    totalOpenMinor: open.reduce((s, o) => s + o.balanceMinor, 0),
    allocations: plan.allocations.map((a) => ({
      grnId: a.invoiceId,
      docNo: docNoOf.get(a.invoiceId) ?? '',
      amountMinor: a.amountMinor,
    })),
    allocatedMinor: plan.allocatedMinor,
    unallocatedMinor: plan.unallocatedMinor,
    existingAdvanceMinor: advance[0]?.n ?? 0,
    unappliedReturnsMinor: returns[0]?.n ?? 0,
  };
}

// ─── Post ───────────────────────────────────────────────────────────────────────────────

export async function postSupplierPayment(
  actor: RequestActor,
  input: SupplierPaymentInput,
): Promise<SupplierPaymentResult> {
  const party = await loadSupplier(actor, input.partyId);
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();

  const result = await withTransaction(async (session) => {
    if (input.mfs) {
      const dup = await PaymentDoc.findOne({
        orgId: actor.orgId,
        'mfs.provider': input.mfs.provider,
        'mfs.trxId': input.mfs.trxId,
      })
        .select('docNo')
        .session(session)
        .lean();
      if (dup) {
        throw ApiError.conflict(
          'DUPLICATE_DOCUMENT',
          `${input.mfs.provider} transaction ${input.mfs.trxId} is already on ${dup.docNo}`,
          { paymentId: String(dup._id), docNo: dup.docNo },
        );
      }
    }
    const docs = await openPayableDocs(actor.orgId, party._id, session);
    const open = docs.map(asOpen);
    const plan =
      input.allocations === undefined
        ? proposeFifo(open, input.amountMinor).allocations
        : toPlan(input.allocations);
    const problems = validateAllocations(open, plan, input.amountMinor);
    if (problems.length) throw refuse(fromProblems(problems));

    const docNo = await nextDocNo(session, actor.orgId, 'PAY', paidAt);
    const id = new Types.ObjectId();
    const allocatedMinor = plan.reduce((s, a) => s + a.amountMinor, 0);
    const payables = await settleBills(session, actor.orgId, plan);

    const [doc] = await PaymentDoc.create(
      [
        {
          _id: id,
          orgId: actor.orgId,
          docNo,
          series: 'PAY',
          direction: 'OUT',
          partyId: party._id,
          paidAt,
          method: input.method,
          amountMinor: input.amountMinor,
          allocatedMinor,
          unallocatedMinor: input.amountMinor - allocatedMinor,
          allocations: allocationDocs(
            plan,
            new Map(open.map((o) => [o.id, o.docNo])),
            paidAt,
            actor.actorId,
          ),
          mfs: input.mfs ?? null,
          reference: input.reference ?? null,
          narration: input.narration ?? null,
          collectedByUserId: actor.actorId,
          createdBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      ],
      { session },
    );

    await postLedgerEntries(session, {
      orgId: actor.orgId,
      postedAt: paidAt,
      actorId: actor.actorId,
      entries: [
        {
          partyId: party._id,
          docType: 'PAYMENT',
          refType: 'PAYMENT',
          refId: id,
          refDocNo: docNo,
          debitMinor: input.amountMinor,
          narration: `Payment ${docNo} (${input.method.toLowerCase()}${
            input.reference ? ` ${input.reference}` : ''
          })${
            payables.length
              ? ` against ${payables.map((p) => p.docNo).join(', ')}`
              : ' — advance'
          }`,
        },
      ],
    });
    return { doc: doc!.toObject(), payables };
  });

  const [payment] = await serialize(actor.orgId, [result.doc]);
  return { payment: payment!, payables: result.payables };
}

// ─── Allocate later ─────────────────────────────────────────────────────────────────────

/**
 * `POST /payments/supplier-payments/:id/allocate` — set an advance against bills that have since
 * arrived. The ledger saw the money when it was paid; only *which bills* it settles changes.
 */
export async function allocateSupplierPayment(
  actor: RequestActor,
  id: Types.ObjectId,
  input: AllocateSupplierPaymentInput,
): Promise<SupplierPaymentResult> {
  const result = await withTransaction(async (session) => {
    const p = await PaymentDoc.findOne({ _id: id, orgId: actor.orgId }).session(session).lean();
    if (!p || p.direction !== 'OUT') throw ApiError.notFound('Supplier payment');
    if (p.status !== 'POSTED' || p.unallocatedMinor <= 0) {
      throw ApiError.conflict('ILLEGAL_TRANSITION', `${p.docNo} has nothing left to allocate`);
    }
    const docs = await openPayableDocs(actor.orgId, p.partyId!, session);
    const open = docs.map(asOpen);
    const plan = input.allocations
      ? toPlan(input.allocations)
      : proposeFifo(open, p.unallocatedMinor).allocations;
    if (plan.length === 0) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'The supplier has no open bills to allocate to',
      );
    }
    const problems = validateAllocations(open, plan, p.unallocatedMinor);
    if (problems.length) throw refuse(fromProblems(problems));

    const sum = plan.reduce((s, a) => s + a.amountMinor, 0);
    const payables = await settleBills(session, actor.orgId, plan);
    const updated = await PaymentDoc.findOneAndUpdate(
      { _id: p._id, orgId: actor.orgId, unallocatedMinor: { $gte: sum } },
      {
        $inc: { allocatedMinor: sum, unallocatedMinor: -sum },
        $push: {
          allocations: {
            $each: allocationDocs(
              plan,
              new Map(open.map((o) => [o.id, o.docNo])),
              new Date(),
              actor.actorId,
            ),
          },
        },
        $set: { updatedBy: actor.actorId },
      },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'This advance was allocated meanwhile — reload',
      );
    }
    return { doc: updated, payables };
  });
  const [payment] = await serialize(actor.orgId, [result.doc]);
  return { payment: payment!, payables: result.payables };
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

export async function listSupplierPayments(
  actor: RequestActor,
  query: ListSupplierPaymentsQuery,
): Promise<{ items: SupplierPaymentPayload[]; meta: PageMeta }> {
  // Refunds are money out too, but to customers and dealers: not supplier payments. Counter
  // refunds from before the flag existed are recognised by their shift.
  const filter: FilterQuery<PaymentDocDoc> = {
    orgId: actor.orgId,
    direction: 'OUT',
    isRefund: { $ne: true },
    posSessionId: null,
  };
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.unallocated) filter.unallocatedMinor = { $gt: 0 };
  if (query.method) filter.method = query.method;
  const { items, meta } = await paginate<PaymentDocDoc>(PaymentDoc, {
    filter,
    query,
    sortable: ['paidAt', 'docNo', 'amountMinor', 'unallocatedMinor'],
    searchFields: ['docNo', 'reference', 'narration'],
    defaultSort: { paidAt: -1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}

export async function getSupplierPayment(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<SupplierPaymentPayload> {
  const doc = await PaymentDoc.findOne({
    _id: id,
    orgId: actor.orgId,
    direction: 'OUT',
  }).lean();
  if (!doc) throw ApiError.notFound('Supplier payment');
  const [payload] = await serialize(actor.orgId, [doc]);
  return payload!;
}
