import { Schema, model } from 'mongoose';

import { CHEQUE_STATUSES, MFS_PROVIDERS, PAYMENT_METHODS } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { ChequeStatus, MfsProvider, PaymentMethod } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * Money received (`RCPT`, direction IN) or paid out (`PAY`, direction OUT). §6.9.
 *
 * A receipt is posted when it is taken, numbered from its series. It is then **allocated** to one
 * or more invoices (Day 28): `allocatedMinor + unallocatedMinor === amountMinor` always, and an
 * unallocated remainder is an advance the dealer can spend later. A cheque's money is not the
 * business's until it clears — `instrument.status` tracks it, and the ledger entry posts on
 * clearing, not on receipt (Day 30).
 */
export interface AllocationDoc {
  /**
   * What is settled: an invoice (a receipt, money in), or a supplier's bill — a posted goods
   * receipt (a supplier payment, money out, Day 35). `invoiceId` holds either: the same machinery
   * settles both, and the direction of the payment says which it is.
   */
  kind: 'INVOICE' | 'GRN';
  invoiceId: Types.ObjectId;
  docNo: string;
  amountMinor: number;
  allocatedAt: Date;
  allocatedBy: Types.ObjectId | null;
  /**
   * Set when the allocation is undone — a cheque that bounced after clearing (Day 30). Kept, not
   * deleted, so ageing can be re-run for any past date and see what was paid *then*.
   */
  reversedAt: Date | null;
}

export interface PaymentDocDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string;
  series: 'RCPT' | 'PAY';
  direction: 'IN' | 'OUT';
  partyId: Types.ObjectId | null;
  locationId: Types.ObjectId | null;
  posSessionId: Types.ObjectId | null;
  paidAt: Date;
  method: PaymentMethod;
  amountMinor: number;
  allocatedMinor: number;
  unallocatedMinor: number;
  allocations: AllocationDoc[];
  instrument: {
    chequeNo: string;
    bankName: string | null;
    branch: string | null;
    chequeDate: Date | null;
    status: ChequeStatus;
    depositedAt: Date | null;
    clearedAt: Date | null;
    bouncedAt: Date | null;
    bounceReason: string | null;
    bounceChargeMinor: number;
  } | null;
  mfs: { provider: MfsProvider; trxId: string; senderNumber: string | null } | null;
  /**
   * A cheque's allocation as chosen when it was taken. Nothing is applied until it clears; then
   * this is applied, capped at what each invoice still owes (Day 30).
   */
  intendedAllocations: { invoiceId: Types.ObjectId; docNo: string; amountMinor: number }[];
  collectedByUserId: Types.ObjectId | null;
  status: 'POSTED' | 'CANCELLED';
  /**
   * Money handed back to a customer or dealer for goods returned (Day 20 counter, Day 36
   * wholesale) — a `PAY` like a supplier payment, but not one: the supplier screens leave it out.
   */
  isRefund: boolean;
  /** A bank transfer reference, a deposit slip number (Day 28). */
  reference: string | null;
  narration: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const allocationSchema = new Schema<AllocationDoc>(
  {
    kind: { type: String, enum: ['INVOICE', 'GRN'], default: 'INVOICE' },
    invoiceId: { type: Schema.Types.ObjectId, required: true },
    docNo: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    allocatedAt: { type: Date, required: true },
    allocatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reversedAt: { type: Date, default: null },
  },
  { _id: true },
);

const instrumentSchema = new Schema(
  {
    chequeNo: { type: String, required: true, trim: true },
    bankName: { type: String, trim: true, default: null },
    branch: { type: String, trim: true, default: null },
    chequeDate: { type: Date, default: null },
    status: { type: String, enum: CHEQUE_STATUSES, default: 'PENDING' },
    depositedAt: { type: Date, default: null },
    clearedAt: { type: Date, default: null },
    bouncedAt: { type: Date, default: null },
    bounceReason: { type: String, trim: true, default: null },
    bounceChargeMinor: { type: Number, default: 0 },
  },
  { _id: false },
);

const mfsSchema = new Schema(
  {
    provider: { type: String, enum: MFS_PROVIDERS, required: true },
    trxId: { type: String, required: true, trim: true },
    senderNumber: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const paymentDocSchema = new Schema<PaymentDocDoc>(
  {
    ...auditableFields,
    docNo: { type: String, required: true },
    series: { type: String, enum: ['RCPT', 'PAY'], required: true },
    direction: { type: String, enum: ['IN', 'OUT'], required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
    posSessionId: { type: Schema.Types.ObjectId, default: null },
    paidAt: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    allocatedMinor: { type: Number, default: 0, min: 0 },
    unallocatedMinor: { type: Number, default: 0, min: 0 },
    allocations: { type: [allocationSchema], default: [] },
    instrument: { type: instrumentSchema, default: null },
    mfs: { type: mfsSchema, default: null },
    intendedAllocations: {
      type: [
        new Schema(
          {
            invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
            docNo: { type: String, required: true },
            amountMinor: { type: Number, required: true, min: 1 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    collectedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['POSTED', 'CANCELLED'], default: 'POSTED' },
    isRefund: { type: Boolean, default: false },
    reference: { type: String, trim: true, default: null },
    narration: { type: String, trim: true, default: null },
  },
  { collection: 'payment_docs' },
);

paymentDocSchema.plugin(baseSchemaPlugin);

paymentDocSchema.index(
  { orgId: 1, series: 1, docNo: 1 },
  { unique: true, name: 'payment_number_unique' },
);
// A party's receipts and payments by date — statements, unapplied receipts.
paymentDocSchema.index({ orgId: 1, partyId: 1, paidAt: -1 });
// Unapplied receipts (Day 29): a party's advances, found without scanning every receipt.
paymentDocSchema.index(
  { orgId: 1, partyId: 1, unallocatedMinor: 1 },
  { partialFilterExpression: { unallocatedMinor: { $gt: 0 } } },
);
// Cheques awaiting deposit or clearing (Day 30).
paymentDocSchema.index(
  { orgId: 1, 'instrument.status': 1, 'instrument.chequeDate': 1 },
  { partialFilterExpression: { method: 'CHEQUE' } },
);
// The shift's takings — the Z-report (Day 20).
paymentDocSchema.index(
  { orgId: 1, posSessionId: 1 },
  { partialFilterExpression: { posSessionId: { $type: 'objectId' } } },
);
// A bKash/Nagad transaction id is used once: a duplicate is a double-entered receipt.
paymentDocSchema.index(
  { orgId: 1, 'mfs.provider': 1, 'mfs.trxId': 1 },
  {
    unique: true,
    partialFilterExpression: { 'mfs.trxId': { $type: 'string' } },
    name: 'mfs_trx_unique',
  },
);

// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every tender and receipt.
paymentDocSchema.index({ orgId: 1, direction: 1, paidAt: -1 });

export const PaymentDoc: Model<PaymentDocDoc> = model<PaymentDocDoc>(
  'PaymentDoc',
  paymentDocSchema,
);
