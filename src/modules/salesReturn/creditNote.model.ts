import { Schema, model } from 'mongoose';

import { SALES_CHANNELS } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { SalesChannel } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * A credit note (`CN-`, Day 36): what a dealer is owed back for goods returned. Raised by a sales
 * return in the same transaction that posts the ledger CREDIT for it, then **allocated** against
 * invoices exactly like a receipt: `allocatedMinor + unallocatedMinor === amountMinor`, each
 * allocation moving an invoice's `creditedMinor` up and its balance down.
 *
 * The ledger saw the whole credit when it was raised; allocating it later only decides which
 * invoices it settles — what ageing and the statement's per-invoice view are built on.
 */
export interface CreditNoteAllocationDoc {
  invoiceId: Types.ObjectId;
  docNo: string;
  amountMinor: number;
  allocatedAt: Date;
  allocatedBy: Types.ObjectId | null;
}

export interface CreditNoteDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string;
  channel: SalesChannel;
  partyId: Types.ObjectId;
  salesReturnId: Types.ObjectId;
  salesReturnDocNo: string;
  invoiceId: Types.ObjectId;
  invoiceDocNo: string;
  postedAt: Date;
  amountMinor: number;
  allocatedMinor: number;
  unallocatedMinor: number;
  allocations: CreditNoteAllocationDoc[];
  status: 'POSTED';
  narration: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const allocationSchema = new Schema<CreditNoteAllocationDoc>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    docNo: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    allocatedAt: { type: Date, required: true },
    allocatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const creditNoteSchema = new Schema<CreditNoteDoc>(
  {
    ...auditableFields,
    docNo: { type: String, required: true },
    channel: { type: String, enum: SALES_CHANNELS, required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    salesReturnId: { type: Schema.Types.ObjectId, ref: 'SalesReturn', required: true },
    salesReturnDocNo: { type: String, required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    invoiceDocNo: { type: String, required: true },
    postedAt: { type: Date, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    allocatedMinor: { type: Number, default: 0, min: 0 },
    unallocatedMinor: { type: Number, default: 0, min: 0 },
    allocations: { type: [allocationSchema], default: [] },
    status: { type: String, enum: ['POSTED'], default: 'POSTED' },
    narration: { type: String, trim: true, default: null },
  },
  { collection: 'credit_notes' },
);

creditNoteSchema.plugin(baseSchemaPlugin);

creditNoteSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, name: 'credit_note_number_unique' },
);
creditNoteSchema.index({ orgId: 1, partyId: 1, postedAt: -1 });
// Open credit: a dealer's unspent credit notes, found without scanning them all.
creditNoteSchema.index(
  { orgId: 1, partyId: 1, unallocatedMinor: 1 },
  { partialFilterExpression: { unallocatedMinor: { $gt: 0 } } },
);

export const CreditNote: Model<CreditNoteDoc> = model<CreditNoteDoc>(
  'CreditNote',
  creditNoteSchema,
);
