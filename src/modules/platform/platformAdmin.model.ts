import bcrypt from 'bcryptjs';
import { Schema, model } from 'mongoose';

import { config } from '../../config/env.js';
import { PLATFORM_PERMISSIONS } from '../../shared/platform.js';

import type { PlatformAdminPayload, PlatformPermission } from '@shared/platform.js';
import type { CallbackError, Model, Types } from 'mongoose';

/**
 * Someone who runs the service — SaaS phase 5.
 *
 * Deliberately **not** a `User`: no `orgId`, no roles, a separate collection, a separate token
 * secret. A platform admin is not a member of any business, and no tenant user can become one by
 * having a role edited. The same email may exist here and in `users`; they are different accounts.
 */
export interface PlatformAdminDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  permissions: PlatformPermission[];
  isActive: boolean;
  mustChangePassword: boolean;
  /** Bumped on logout, password change or a permission change — ends every session at once. */
  tokenVersion: number;
  lastLoginAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformAdminMethods {
  verifyPassword(plain: string): Promise<boolean>;
}

export type PlatformAdminModel = Model<PlatformAdminDoc, object, PlatformAdminMethods>;

const platformAdminSchema = new Schema<
  PlatformAdminDoc,
  PlatformAdminModel,
  PlatformAdminMethods
>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    permissions: { type: [{ type: String, enum: PLATFORM_PERMISSIONS }], default: [] },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', default: null },
  },
  { timestamps: true, versionKey: false, collection: 'platform_admins' },
);

platformAdminSchema.index({ email: 1 }, { unique: true });

/** Hash on the way in, always — the same rule as `User`. */
platformAdminSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('passwordHash')) {
    next();
    return;
  }
  try {
    this.passwordHash = await bcrypt.hash(this.passwordHash, config.bcryptRounds);
    next();
  } catch (err) {
    next(err as CallbackError);
  }
});

platformAdminSchema.method('verifyPassword', function verifyPassword(plain: string) {
  if (!this.passwordHash) {
    throw new Error('verifyPassword called on an admin loaded without passwordHash');
  }
  return bcrypt.compare(plain, this.passwordHash);
});

export const PlatformAdmin = model<PlatformAdminDoc, PlatformAdminModel>(
  'PlatformAdmin',
  platformAdminSchema,
);

export function toPlatformAdminPayload(doc: PlatformAdminDoc): PlatformAdminPayload {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    permissions: [...doc.permissions],
    isActive: doc.isActive,
    mustChangePassword: doc.mustChangePassword,
    lastLoginAt: doc.lastLoginAt ? doc.lastLoginAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}
