import { Schema, model } from 'mongoose';

import { RETURN_REASONS, RETURN_SETTLEMENTS, SALES_CHANNELS } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { ReturnReason, ReturnSettlement, SalesChannel } from '@shared/enums.js';
import type { SalesReturnPayload } from '@shared/types.js';
import type { Model, Types } from 'mongoose';

/**
 * Goods coming back against an invoice (§6.9). Day 20 posts counter returns through
 * `POST /pos/returns`; Day 36 adds the wholesale side, drafts and approval on the same model.
 *
 * A return is **posted whole** in one transaction — its stock, its money and the invoice's
 * returned quantities — so `status` is only ever POSTED here. Its value per line is the line's
 * own net price for the units returned (discounts included), prorated with cumulative rounding so
 * that returning a line piece by piece refunds exactly what the line cost, to the poisha.
 */
export interface SalesReturnLineDoc {
  invoiceLineId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  description: string;
  lotId: Types.ObjectId | null;
  serials: string[];
  qtyBase: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  condition: 'GOOD' | 'DAMAGED';
  /** GOOD is restocked at the counter; DAMAGED comes in and is written off in the same posting. */
  restock: boolean;
  restockLocationId: Types.ObjectId;
}

export interface SalesReturnDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string;
  channel: SalesChannel;
  invoiceId: Types.ObjectId;
  invoiceDocNo: string;
  partyId: Types.ObjectId | null;
  customerName: string | null;
  locationId: Types.ObjectId;
  posSessionId: Types.ObjectId | null;
  returnDate: Date;
  reason: ReturnReason;
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  lines: SalesReturnLineDoc[];
  subtotalMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  settlement: ReturnSettlement;
  creditNoteDocNo: string | null;
  creditNoteId: Types.ObjectId | null;
  refundPaymentId: Types.ObjectId | null;
  refundDocNo: string | null;
  /** An exchange's credit, once a sale has spent it — set by that sale's transaction. */
  replacementInvoiceId: Types.ObjectId | null;
  replacementDocNo: string | null;
  clientRef: string | null;
  note: string | null;
  postedAt: Date;
  postedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<SalesReturnLineDoc>(
  {
    invoiceLineId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    description: { type: String, required: true },
    lotId: { type: Schema.Types.ObjectId, ref: 'Lot', default: null },
    serials: { type: [String], default: [] },
    qtyBase: { type: Number, required: true, min: 1 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
    condition: { type: String, enum: ['GOOD', 'DAMAGED'], required: true },
    restock: { type: Boolean, required: true },
    restockLocationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
  },
  { _id: false },
);

const salesReturnSchema = new Schema<SalesReturnDoc>(
  {
    ...auditableFields,
    docNo: { type: String, required: true },
    channel: { type: String, enum: SALES_CHANNELS, required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    invoiceDocNo: { type: String, required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
    customerName: { type: String, default: null },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    posSessionId: { type: Schema.Types.ObjectId, default: null },
    returnDate: { type: Date, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    status: { type: String, enum: ['DRAFT', 'POSTED', 'CANCELLED'], default: 'POSTED' },
    lines: { type: [lineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    grandTotalMinor: { type: Number, required: true, min: 0 },
    settlement: { type: String, enum: RETURN_SETTLEMENTS, required: true },
    creditNoteDocNo: { type: String, default: null },
    creditNoteId: { type: Schema.Types.ObjectId, ref: 'CreditNote', default: null },
    refundPaymentId: { type: Schema.Types.ObjectId, ref: 'PaymentDoc', default: null },
    refundDocNo: { type: String, default: null },
    replacementInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    replacementDocNo: { type: String, default: null },
    clientRef: { type: String, default: null },
    note: { type: String, trim: true, default: null },
    postedAt: { type: Date, required: true },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'sales_returns' },
);

salesReturnSchema.plugin(baseSchemaPlugin);

salesReturnSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, name: 'sales_return_number_unique' },
);
salesReturnSchema.index(
  { orgId: 1, clientRef: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRef: { $type: 'string' } },
    name: 'sales_return_client_ref_unique',
  },
);
// The returns list, newest first, per channel.
salesReturnSchema.index({ orgId: 1, channel: 1, postedAt: -1 });
// An invoice's returns — the returns screen shows what already came back.
salesReturnSchema.index({ orgId: 1, invoiceId: 1 });
// The shift's returns — the Z-report.
salesReturnSchema.index(
  { orgId: 1, posSessionId: 1 },
  { partialFilterExpression: { posSessionId: { $type: 'objectId' } } },
);

// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every return.
salesReturnSchema.index({ orgId: 1, postedAt: -1, _id: -1 });

export const SalesReturn: Model<SalesReturnDoc> = model<SalesReturnDoc>(
  'SalesReturn',
  salesReturnSchema,
);

export function toSalesReturnPayload(doc: SalesReturnDoc): SalesReturnPayload {
  return {
    id: String(doc._id),
    docNo: doc.docNo,
    channel: doc.channel,
    invoiceId: String(doc.invoiceId),
    invoiceDocNo: doc.invoiceDocNo,
    partyId: doc.partyId ? String(doc.partyId) : null,
    customerName: doc.customerName,
    locationId: String(doc.locationId),
    posSessionId: doc.posSessionId ? String(doc.posSessionId) : null,
    returnDate: doc.returnDate.toISOString(),
    reason: doc.reason,
    settlement: doc.settlement,
    lines: doc.lines.map((l) => ({
      invoiceLineId: String(l.invoiceLineId),
      productId: String(l.productId),
      variantId: l.variantId ? String(l.variantId) : null,
      description: l.description,
      serials: l.serials,
      qtyBase: l.qtyBase,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
      condition: l.condition,
      restockLocationId: String(l.restockLocationId),
    })),
    grandTotalMinor: doc.grandTotalMinor,
    creditNoteDocNo: doc.creditNoteDocNo,
    creditNoteId: doc.creditNoteId ? String(doc.creditNoteId) : null,
    refundDocNo: doc.refundDocNo,
    replacementInvoiceId: doc.replacementInvoiceId ? String(doc.replacementInvoiceId) : null,
    replacementDocNo: doc.replacementDocNo,
    note: doc.note,
    postedAt: doc.postedAt.toISOString(),
  };
}
