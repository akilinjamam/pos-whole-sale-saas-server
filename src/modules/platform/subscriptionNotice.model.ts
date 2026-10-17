import { Schema, model } from 'mongoose';

import type { Model, Types } from 'mongoose';

/**
 * Every email the daily subscription job has sent — SaaS phase 6. Platform-level: `orgId` names
 * the business it was about (null for the weekly summary), but nothing tenant-side reads it.
 *
 * The unique `key` is how each notice goes out exactly once: the job **inserts the key first** and
 * sends only if the insert won, so two runs at the same moment (cron plus a manual run) cannot both
 * send. If the send then fails, the key is deleted again and the next run retries.
 *
 * Keys carry the end date they are about — `<orgId>:ENDING:3:<endsAt>` — so a renewal, with its
 * new end date, starts the reminders over.
 */
export const SUBSCRIPTION_NOTICE_KINDS = ['ENDING', 'EXPIRED', 'READ_ONLY', 'WEEKLY_SUMMARY'] as const;
export type SubscriptionNoticeKind = (typeof SUBSCRIPTION_NOTICE_KINDS)[number];

export interface SubscriptionNoticeDoc {
  _id: Types.ObjectId;
  key: string;
  orgId: Types.ObjectId | null;
  kind: SubscriptionNoticeKind;
  to: string[];
  sentAt: Date;
}

const subscriptionNoticeSchema = new Schema<SubscriptionNoticeDoc>(
  {
    key: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', default: null },
    kind: { type: String, enum: SUBSCRIPTION_NOTICE_KINDS, required: true },
    to: { type: [String], default: [] },
    sentAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'subscription_notices' },
);

subscriptionNoticeSchema.index({ key: 1 }, { unique: true });
subscriptionNoticeSchema.index({ orgId: 1, sentAt: -1 });

export const SubscriptionNotice: Model<SubscriptionNoticeDoc> = model<SubscriptionNoticeDoc>(
  'SubscriptionNotice',
  subscriptionNoticeSchema,
);
