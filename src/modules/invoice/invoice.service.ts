import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { startOfDayIn } from '../../lib/period.js';
import { Org } from '../org/org.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';
import { invoicePayload } from '../pos/posSale.service.js';
import { CreditNote } from '../salesReturn/creditNote.model.js';
import { SalesReturn } from '../salesReturn/salesReturn.model.js';

import { Invoice } from './invoice.model.js';

import type { InvoiceDoc } from './invoice.model.js';
import type { ListInvoicesQuery } from './invoice.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { InvoiceActivity, InvoicePayload, PageMeta } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * Invoices, read-only. They are *written* only by the documents that raise them — a counter sale
 * (Day 18) or a posted challan (Day 24) — inside those documents' transactions, and settled only
 * by the documents that pay or credit them: receipts (Day 28), credit notes and returns (Day 36).
 */

export async function getInvoice(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<InvoicePayload> {
  const doc = await Invoice.findOne({ _id: id, orgId: actor.orgId }).lean();
  const scope = locationScopeOf(actor.user);
  // An opening-balance invoice has no location: it belongs to the account, visible to everyone
  // who may read invoices.
  if (!doc || (scope && doc.locationId && !scope.includes(String(doc.locationId)))) {
    throw ApiError.notFound('Invoice');
  }
  return invoicePayload(doc);
}

export async function listInvoices(
  actor: RequestActor,
  query: ListInvoicesQuery,
): Promise<{ items: InvoicePayload[]; meta: PageMeta }> {
  const filter: FilterQuery<InvoiceDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (scope) {
    filter.$or = [
      { locationId: { $in: scope.map((id) => new Types.ObjectId(id)) } },
      { locationId: null },
    ];
  }
  if (query.orderId) filter.orderId = new Types.ObjectId(query.orderId);
  if (query.dispatchId) filter.dispatchId = new Types.ObjectId(query.dispatchId);
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.channel) filter.channel = query.channel;
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  if (query.open) filter.balanceMinor = { $gt: 0 };
  if (query.from || query.to) {
    const zone =
      (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
    filter.invoiceDate = {
      ...(query.from ? { $gte: startOfDayIn(query.from, zone) } : {}),
      ...(query.to
        ? { $lt: new Date(startOfDayIn(query.to, zone).getTime() + 86_400_000) }
        : {}),
    };
  }

  const { items, meta } = await paginate<InvoiceDoc>(Invoice, {
    filter,
    query,
    sortable: ['invoiceDate', 'docNo', 'grandTotalMinor', 'dueDate'],
    searchFields: ['docNo', 'partySnapshot.name', 'walkInName'],
    defaultSort: { invoiceDate: -1 },
  });
  return { items: await Promise.all(items.map(invoicePayload)), meta };
}

/**
 * `GET /invoices/:id/activity` — what has settled this invoice and what came back against it: the
 * payments (counter tenders and receipts) allocated to it, the credit notes set against it, and
 * its returns. The invoice's own paid / credited figures are these, added up.
 */
export async function invoiceActivity(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<InvoiceActivity> {
  await getInvoice(actor, id); // existence and location scope
  const [payments, notes, returns] = await Promise.all([
    PaymentDoc.find({ orgId: actor.orgId, direction: 'IN', 'allocations.invoiceId': id })
      .sort({ paidAt: 1 })
      .lean(),
    CreditNote.find({ orgId: actor.orgId, 'allocations.invoiceId': id })
      .sort({ postedAt: 1 })
      .lean(),
    SalesReturn.find({ orgId: actor.orgId, invoiceId: id }).sort({ postedAt: 1 }).lean(),
  ]);
  const mine = <T extends { invoiceId: Types.ObjectId }>(xs: T[]) =>
    xs.filter((a) => a.invoiceId.equals(id));
  return {
    payments: payments.flatMap((p) =>
      mine(p.allocations).map((a) => ({
        id: String(p._id),
        docNo: p.docNo,
        method: p.method,
        paidAt: p.paidAt.toISOString(),
        amountMinor: a.amountMinor,
        reversedAt: a.reversedAt ? a.reversedAt.toISOString() : null,
        chequeNo: p.instrument?.chequeNo ?? null,
      })),
    ),
    creditNotes: notes.flatMap((n) =>
      mine(n.allocations).map((a) => ({
        id: String(n._id),
        docNo: n.docNo,
        allocatedAt: a.allocatedAt.toISOString(),
        amountMinor: a.amountMinor,
        salesReturnDocNo: n.salesReturnDocNo,
      })),
    ),
    returns: returns.map((r) => ({
      id: String(r._id),
      docNo: r.docNo,
      postedAt: r.postedAt.toISOString(),
      settlement: r.settlement,
      grandTotalMinor: r.grandTotalMinor,
      creditNoteDocNo: r.creditNoteDocNo,
      refundDocNo: r.refundDocNo,
      qtyBase: r.lines.reduce((t, l) => t + l.qtyBase, 0),
    })),
  };
}
