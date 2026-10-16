import { Schema, model } from 'mongoose';

import type { Model, Types } from 'mongoose';

/**
 * One-time tokens sent by email — SaaS phase 3.
 *
 * Only a SHA-256 hash is stored, never the token: the database (or a backup of it) is then not a
 * list of working password-reset links. A token is single-use (`usedAt`) and short-lived; the
 * TTL index lets MongoDB delete it a day after it expires, so nothing accumulates.
 *
 * Carries `orgId` like every other collection, so `cleanupOrg` and a business's data export and
 * deletion (phase 7) include it.
 */

export const EMAIL_TOKEN_PURPOSES = ['VERIFY_EMAIL', 'RESET_PASSWORD'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export interface EmailTokenDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: EmailTokenPurpose;
  /**
   * The address the link was sent to. A user who changes their email after asking for a link
   * cannot then use it to "verify" the new address they never received mail at.
   */
  email: string;
  /** hex SHA-256 of the token in the link. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailTokenSchema = new Schema<EmailTokenDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'email_tokens' },
);

emailTokenSchema.index({ tokenHash: 1 }, { unique: true });
emailTokenSchema.index({ userId: 1, purpose: 1, usedAt: 1 });
// Removed by MongoDB a day after expiry — kept that long so a late click still gets a clear
// "this link has expired" rather than "no such link".
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const EmailToken: Model<EmailTokenDoc> = model<EmailTokenDoc>('EmailToken', emailTokenSchema);
