import { Types } from 'mongoose';

import { paymentStatusOf, proposeFifo, validateAllocations } from '../../domain/allocation.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Party } from '../party/party.model.js';
import { asOpen, openInvoiceDocs } from '../payment/receipt.service.js';

import { CreditNote } from './creditNote.model.js';

import type { CreditNoteAllocationDoc, CreditNoteDoc } from './creditNote.model.js';
import type { ListCreditNotesQuery } from './salesReturn.schema.js';
import type { Allocation, AllocationProblem } from '../../domain/allocation.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { SalesChannel } from '@shared/enums.js';
import type { AllocateCreditNoteInput, CreditAllocationInput } from '@shared/returns.js';
import type { CreditNotePayload, PageMeta } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Credit notes (Day 36) — raised by sales returns, spent against invoices with the same allocation
 * rules as receipts (`domain/allocation`): an open invoice of this dealer, once, for no more than
 * it still owes, all of it within what the note is worth.
 */

const refuse = (problems: AllocationProblem[]) =>
  ApiError.validation('Validation failed', problems);

/**
 * Set credit against invoices, inside the caller's transaction. Each `$inc` is guarded by what the
 * invoice still owes, so a credit note and a receipt racing for one invoice cannot overpay it.
 */
async function settleWithCredit(
  session: ClientSession,
  orgId: Types.ObjectId,
  plan: readonly Allocation[],
): Promise<void> {
  for (const a of plan) {
    const inv = await Invoice.findOneAndUpdate(
      {
        _id: new Types.ObjectId(a.invoiceId),
        orgId,
        status: 'POSTED',
        balanceMinor: { $gte: a.amountMinor },
      },
      { $inc: { creditedMinor: a.amountMinor, balanceMinor: -a.amountMinor } },
      { new: true, session },
    ).lean();
    if (!inv) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'An invoice was paid meanwhile — reload the allocation and try again',
        { invoiceId: a.invoiceId },
      );
    }
    const paymentStatus = paymentStatusOf(
      inv.grandTotalMinor,
      inv.paidMinor,
      inv.creditedMinor ?? 0,
    );
    if (paymentStatus !== inv.paymentStatus) {
      await Invoice.updateOne({ _id: inv._id }, { $set: { paymentStatus } }, { session });
    }
  }
}

const allocationDocs = (
  plan: readonly Allocation[],
  docNoOf: Map<string, string>,
  at: Date,
  by: Types.ObjectId,
): CreditNoteAllocationDoc[] =>
  plan.map((a) => ({
    invoiceId: new Types.ObjectId(a.invoiceId),
    docNo: docNoOf.get(a.invoiceId) ?? '',
    amountMinor: a.amountMinor,
    allocatedAt: at,
    allocatedBy: by,
  }));

export interface RaiseCreditNote {
  channel: SalesChannel;
  partyId: Types.ObjectId;
  salesReturnId: Types.ObjectId;
  salesReturnDocNo: string;
  invoiceId: Types.ObjectId;
  invoiceDocNo: string;
  amountMinor: number;
  at: Date;
  /**
   * Omitted: against the invoice the goods came back from, as far as it still owes. Empty: none.
   * Otherwise exactly these, validated against the dealer's open invoices now.
   */
  allocations?: readonly CreditAllocationInput[];
  narration: string;
}

/**
 * Raise a credit note inside the return's transaction: its number, its ledger CREDIT, and its
 * allocation. The ledger entry is the whole note — the dealer owes that much less at once.
 */
export async function raiseCreditNote(
  session: ClientSession,
  actor: RequestActor,
  input: RaiseCreditNote,
): Promise<CreditNoteDoc> {
  const open = (await openInvoiceDocs(actor.orgId, input.partyId, session)).map(asOpen);
  const origin = open.find((o) => o.id === String(input.invoiceId));
  const plan: Allocation[] =
    input.allocations === undefined
      ? origin && origin.balanceMinor > 0
        ? [
            {
              invoiceId: origin.id,
              amountMinor: Math.min(input.amountMinor, origin.balanceMinor),
            },
          ]
        : []
      : input.allocations.map((a) => ({ invoiceId: a.invoiceId, amountMinor: a.amountMinor }));
  const problems = validateAllocations(open, plan, input.amountMinor);
  if (problems.length) throw refuse(problems);

  const docNo = await nextDocNo(session, actor.orgId, 'CN', input.at);
  await settleWithCredit(session, actor.orgId, plan);
  const allocatedMinor = plan.reduce((t, a) => t + a.amountMinor, 0);
  const [doc] = await CreditNote.create(
    [
      {
        orgId: actor.orgId,
        docNo,
        channel: input.channel,
        partyId: input.partyId,
        salesReturnId: input.salesReturnId,
        salesReturnDocNo: input.salesReturnDocNo,
        invoiceId: input.invoiceId,
        invoiceDocNo: input.invoiceDocNo,
        postedAt: input.at,
        amountMinor: input.amountMinor,
        allocatedMinor,
        unallocatedMinor: input.amountMinor - allocatedMinor,
        allocations: allocationDocs(
          plan,
          new Map(open.map((o) => [o.id, o.docNo])),
          input.at,
          actor.actorId,
        ),
        narration: input.narration,
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      },
    ],
    { session },
  );
  await postLedgerEntries(session, {
    orgId: actor.orgId,
    postedAt: input.at,
    actorId: actor.actorId,
    entries: [
      {
        partyId: input.partyId,
        docType: 'CREDIT_NOTE',
        refType: 'CREDIT_NOTE',
        refId: doc!._id,
        refDocNo: docNo,
        creditMinor: input.amountMinor,
        narration: input.narration,
      },
    ],
  });
  return doc!.toObject();
}

// ─── Spend later ────────────────────────────────────────────────────────────────────────

/**
 * `POST /credit-notes/:id/allocate` — set (part of) an open credit against invoices. Nothing posts
 * to the ledger: the credit was there from the moment the note was raised.
 */
export async function allocateCreditNote(
  actor: RequestActor,
  id: Types.ObjectId,
  input: AllocateCreditNoteInput,
): Promise<CreditNotePayload> {
  const updated = await withTransaction(async (session) => {
    const cn = await CreditNote.findOne({ _id: id, orgId: actor.orgId })
      .session(session)
      .lean();
    if (!cn) throw ApiError.notFound('Credit note');
    if (cn.unallocatedMinor <= 0) {
      throw ApiError.conflict('ILLEGAL_TRANSITION', `${cn.docNo} has nothing left to allocate`);
    }
    const open = (await openInvoiceDocs(actor.orgId, cn.partyId, session)).map(asOpen);
    const plan: Allocation[] = input.allocations
      ? input.allocations.map((a) => ({ invoiceId: a.invoiceId, amountMinor: a.amountMinor }))
      : proposeFifo(open, cn.unallocatedMinor).allocations;
    if (plan.length === 0) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'The dealer has no open invoices to set it against',
      );
    }
    const problems = validateAllocations(open, plan, cn.unallocatedMinor);
    if (problems.length) throw refuse(problems);

    const sum = plan.reduce((t, a) => t + a.amountMinor, 0);
    await settleWithCredit(session, actor.orgId, plan);
    const doc = await CreditNote.findOneAndUpdate(
      { _id: cn._id, orgId: actor.orgId, unallocatedMinor: { $gte: sum } },
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
    if (!doc)
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'This credit was allocated meanwhile — reload',
      );
    return doc;
  });
  const [payload] = await serialize(actor.orgId, [updated]);
  return payload!;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

export async function serialize(
  orgId: Types.ObjectId,
  docs: CreditNoteDoc[],
): Promise<CreditNotePayload[]> {
  const parties = await Party.find({ orgId, _id: { $in: docs.map((d) => d.partyId) } })
    .select('name displayName code')
    .lean();
  const by = new Map(parties.map((p) => [String(p._id), p]));
  return docs.map((d) => {
    const p = by.get(String(d.partyId));
    return {
      id: String(d._id),
      docNo: d.docNo,
      channel: d.channel,
      partyId: String(d.partyId),
      partyName: p ? (p.displayName ?? p.name) : undefined,
      partyCode: p?.code,
      salesReturnId: String(d.salesReturnId),
      salesReturnDocNo: d.salesReturnDocNo,
      invoiceId: String(d.invoiceId),
      invoiceDocNo: d.invoiceDocNo,
      postedAt: d.postedAt.toISOString(),
      amountMinor: d.amountMinor,
      allocatedMinor: d.allocatedMinor,
      unallocatedMinor: d.unallocatedMinor,
      allocations: d.allocations.map((a) => ({
        invoiceId: String(a.invoiceId),
        docNo: a.docNo,
        amountMinor: a.amountMinor,
        allocatedAt: a.allocatedAt.toISOString(),
      })),
      narration: d.narration,
    };
  });
}

export async function listCreditNotes(
  actor: RequestActor,
  query: ListCreditNotesQuery,
): Promise<{ items: CreditNotePayload[]; meta: PageMeta }> {
  const filter: FilterQuery<CreditNoteDoc> = { orgId: actor.orgId };
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.channel) filter.channel = query.channel;
  if (query.unallocated) filter.unallocatedMinor = { $gt: 0 };
  const { items, meta } = await paginate<CreditNoteDoc>(CreditNote, {
    filter,
    query,
    sortable: ['postedAt', 'docNo', 'amountMinor', 'unallocatedMinor'],
    searchFields: ['docNo', 'invoiceDocNo', 'salesReturnDocNo'],
    defaultSort: { postedAt: -1, _id: -1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}

export async function getCreditNote(actor: RequestActor, id: Types.ObjectId) {
  const doc = await CreditNote.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Credit note');
  const [payload] = await serialize(actor.orgId, [doc]);
  return payload!;
}
