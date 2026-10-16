import { Schema, model } from 'mongoose';

import { SUBSCRIPTION_PAYMENT_METHODS } from '../../shared/platform.js';

import type { SubscriptionPaymentMethod } from '@shared/platform.js';
import type { Model, Types } from 'mongoose';

/**
 * A business paying for its subscription — SaaS phase 5. Recorded by a platform admin when the
 * bKash / bank / cash payment arrives; it extends `Org.currentPeriodEndsAt` and sets the business
 * ACTIVE, in the same transaction.
 *
 * Carries `orgId` — it is the business's own record of what it paid — so the business's data export
 * and deletion (phase 7) include it. It is **not** written through the tenant API: no tenant route
 * creates or edits one.
 *
 * Like the ledgers, a recorded payment is never edited or deleted; a mistake is corrected by a
 * platform admin with a note, in a later phase if it ever comes up.
 */
export interface SubscriptionPaymentDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  /** `SUB-2026-00001` — platform-wide, yearly. */
  receiptNo: string;
  amountMinor: number;
  method: SubscriptionPaymentMethod;
  /** bKash / Nagad transaction id, or the bank reference. One payment per (method, trxId). */
  trxId: string | null;
  months: number;
  planCode: string;
  periodStart: Date;
  periodEnd: Date;
  paidAt: Date;
  note: string | null;
  recordedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionPaymentSchema = new Schema<SubscriptionPaymentDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    receiptNo: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, enum: SUBSCRIPTION_PAYMENT_METHODS, required: true },
    trxId: { type: String, trim: true, default: null },
    months: { type: Number, required: true, min: 1, max: 36 },
    planCode: { type: String, required: true, uppercase: true, trim: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    paidAt: { type: Date, required: true },
    note: { type: String, trim: true, default: null },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', required: true },
  },
  { timestamps: true, versionKey: false, collection: 'subscription_payments' },
);

subscriptionPaymentSchema.index({ receiptNo: 1 }, { unique: true });
subscriptionPaymentSchema.index({ paidAt: -1 });
// The same bKash transaction cannot be recorded twice — a double entry is the likeliest mistake.
subscriptionPaymentSchema.index(
  { method: 1, trxId: 1 },
  {
    unique: true,
    partialFilterExpression: { trxId: { $type: 'string' } },
    name: 'sub_payment_trx_unique',
  },
);

export const SubscriptionPayment: Model<SubscriptionPaymentDoc> = model<SubscriptionPaymentDoc>(
  'SubscriptionPayment',
  subscriptionPaymentSchema,
);
