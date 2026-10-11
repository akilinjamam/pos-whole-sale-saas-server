import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';
import { GRN_STATUSES, PAYMENT_STATUSES, QC_STATUSES } from '../../shared/enums.js';

import type { GrnStatus, PaymentStatus, QcStatus } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * A goods receipt — §6.8. What arrived from a supplier, against a PO or directly (`poId: null`).
 *
 * A draft is freely editable and has no number. **Posting** is one transaction
 * (`goodsReceipt.service.postGrn`): lots → stock IN → moving-average cost → the PO's received
 * counters and status → the supplier's ledger credit. Posting is final: goods that go back are a
 * purchase return.
 *
 * Once posted it is also the supplier's bill — the payable Day 35's supplier payments allocate
 * against — so it carries a balance, like an invoice does on the sell side.
 */

export interface GrnLineDoc {
  lineNo: number;
  poLineId: Types.ObjectId | null;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  qty: number;
  qtyBase: number;
  /** Per `uomCode`, as on the supplier's bill. */
  unitCostMinor: number;
  discountPct: number;
  discountMinor: number;
  /** Net: qty × unit cost − discount. Zero for a damaged line — it is not owed. */
  lineTotalMinor: number;
  /** Per base unit, with the line's share of the other charges. Set on posting. */
  landedUnitCostMinor: number | null;
  lotNo: string | null;
  mfgDate: Date | null;
  expiryDate: Date | null;
  serials: string[];
  qcStatus: QcStatus;
  /** Sent back since, by purchase returns (Day 34) — never more than `qtyBase`. */
  qtyReturnedBase: number;
}

export interface GoodsReceiptDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string | null;
  poId: Types.ObjectId | null;
  supplierPartyId: Types.ObjectId;
  locationId: Types.ObjectId;
  status: GrnStatus;
  receivedAt: Date;
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: Date | null;
  lines: GrnLineDoc[];
  subtotalMinor: number;
  discountMinor: number;
  otherChargesMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  paidMinor: number;
  /** Taken off the bill by purchase returns against it (Day 35). */
  creditedMinor: number;
  balanceMinor: number;
  paymentStatus: PaymentStatus;
  dueDate: Date | null;
  note: string | null;
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<GrnLineDoc>(
  {
    lineNo: { type: Number, required: true, min: 1 },
    poLineId: { type: Schema.Types.ObjectId, default: null },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    uomCode: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    qtyBase: { type: Number, required: true, min: 1 },
    unitCostMinor: { type: Number, required: true, min: 0 },
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    discountMinor: { type: Number, default: 0, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
    landedUnitCostMinor: { type: Number, default: null },
    lotNo: { type: String, trim: true, uppercase: true, default: null },
    mfgDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    serials: { type: [String], default: [] },
    qcStatus: { type: String, enum: QC_STATUSES, default: 'OK' },
    qtyReturnedBase: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const goodsReceiptSchema = new Schema<GoodsReceiptDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    poId: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null },
    supplierPartyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    status: { type: String, enum: GRN_STATUSES, default: 'DRAFT' },
    receivedAt: { type: Date, required: true },
    supplierInvoiceNo: { type: String, trim: true, uppercase: true, default: null },
    supplierInvoiceDate: { type: Date, default: null },
    lines: { type: [lineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0, min: 0 },
    discountMinor: { type: Number, default: 0, min: 0 },
    otherChargesMinor: { type: Number, default: 0, min: 0 },
    taxMinor: { type: Number, default: 0 },
    grandTotalMinor: { type: Number, default: 0, min: 0 },
    paidMinor: { type: Number, default: 0, min: 0 },
    creditedMinor: { type: Number, default: 0, min: 0 },
    balanceMinor: { type: Number, default: 0, min: 0 },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'UNPAID' },
    dueDate: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
    postedAt: { type: Date, default: null },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, default: null },
  },
  { collection: 'goods_receipts' },
);

goodsReceiptSchema.plugin(baseSchemaPlugin);

// One number, one receipt. Drafts (docNo null) are exempt.
goodsReceiptSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
// One supplier bill, entered once: a second posted receipt quoting the same bill number from the
// same supplier is refused by the database itself, not just by a check that could race.
goodsReceiptSchema.index(
  { orgId: 1, supplierPartyId: 1, supplierInvoiceNo: 1 },
  {
    unique: true,
    name: 'one_posted_receipt_per_supplier_bill',
    partialFilterExpression: { status: 'POSTED', supplierInvoiceNo: { $type: 'string' } },
  },
);
goodsReceiptSchema.index({ orgId: 1, status: 1, receivedAt: -1 });
goodsReceiptSchema.index({ orgId: 1, poId: 1 });
// The supplier's payables, oldest due first — Day 35's allocation reads this.
goodsReceiptSchema.index({ orgId: 1, supplierPartyId: 1, status: 1, dueDate: 1 });

// The purchase register (Day 35): posted bills in a period.
goodsReceiptSchema.index({ orgId: 1, status: 1, postedAt: 1 });

export const GoodsReceipt: Model<GoodsReceiptDoc> = model<GoodsReceiptDoc>(
  'GoodsReceipt',
  goodsReceiptSchema,
);
