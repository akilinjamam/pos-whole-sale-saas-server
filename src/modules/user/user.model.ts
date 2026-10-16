import bcrypt from 'bcryptjs';
import { Schema, model } from 'mongoose';

import { config } from '../../config/env.js';
import {
  auditableFields,
  baseSchemaPlugin,
  idToString,
  idsToStrings,
} from '../../lib/model.js';
import { toPermissions } from '../../shared/permissions.js';

import type { UserPayload } from '@shared/types.js';
import type { Permission } from '@shared/permissions.js';
import type { CallbackError, HydratedDocument, Model, Types } from 'mongoose';

/**
 * An operator of the system.
 *
 * Access is `union(roles.permissions) ∪ permissionGrants \ permissionRevokes`. The two override
 * arrays exist so a one-off ("this rep may also see cost") does not require inventing a whole
 * role, which is how permission systems rot into forty near-identical roles.
 *
 * `tokenVersion` is the revocation lever. Access tokens live 15 minutes and carry the caller's
 * permissions; without this, demoting someone would leave their elevated token valid until it
 * expired. Bumping the version invalidates every token ever issued to them, instantly — it is
 * checked in `authenticate` on every request.
 *
 * `locationIds` scopes what they can touch; `requireLocation` asserts any `locationId` in a
 * request is in this list, and list services filter reads by the same set.
 */
export interface UserDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  roleIds: Types.ObjectId[];
  permissionGrants: string[];
  permissionRevokes: string[];
  locationIds: Types.ObjectId[];
  defaultLocationId: Types.ObjectId | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  tokenVersion: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserMethods {
  verifyPassword(plain: string): Promise<boolean>;
}

export type UserDocument = HydratedDocument<UserDoc, UserMethods>;
export type UserModel = Model<UserDoc, Record<string, never>, UserMethods>;

const userSchema = new Schema<UserDoc, UserModel, UserMethods>({
  ...auditableFields,
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, trim: true, default: null },
  // `select: false` so a stray `User.find()` in some future list endpoint cannot serialise
  // the hash into a response. Every read that needs it asks for it explicitly.
  passwordHash: { type: String, required: true, select: false },
  roleIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Role' }], default: [] },
  permissionGrants: { type: [String], default: [] },
  permissionRevokes: { type: [String], default: [] },
  locationIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Location' }], default: [] },
  defaultLocationId: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
  isActive: { type: Boolean, default: true, index: true },
  mustChangePassword: { type: Boolean, default: false },
  lastLoginAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 0 },
});

userSchema.plugin(baseSchemaPlugin);

// Unique across the platform, not per org (SaaS phase 1): login is email + password with no
// business code, so an email has to identify exactly one user. The seed drops the old
// `orgId_1_email_1` index when it migrates a database.
userSchema.index({ email: 1 }, { unique: true });

/**
 * Hash on the way in, always.
 *
 * A pre-save hook rather than hashing in the service, so there is exactly one path a password
 * can take into this collection — a future "reset password" endpoint written by someone who
 * has not read the service cannot accidentally store plaintext.
 *
 * The guard matters: without `isModified`, every unrelated save (a name edit, a `lastLoginAt`
 * stamp) would re-hash the already-hashed value and lock the user out.
 */
userSchema.pre('save', async function hashPassword(next) {
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

userSchema.method('verifyPassword', function verifyPassword(plain: string): Promise<boolean> {
  // A document loaded without the `select: false` field would compare against `undefined`,
  // which bcrypt resolves as `false` — a silent "wrong password" for every user. Be loud.
  if (!this.passwordHash) {
    throw new Error('verifyPassword called on a user loaded without passwordHash');
  }
  return bcrypt.compare(plain, this.passwordHash);
});

export const User: UserModel = model<UserDoc, UserModel>('User', userSchema);

/**
 * Model → wire shape.
 *
 * `effectivePermissions` is resolved by the caller (it needs the role documents) and passed in,
 * so the list screen can show what a user can actually do without the client loading every
 * role and re-deriving the union itself.
 */
export function toUserPayload(
  doc: UserDoc,
  effective: Permission[],
  roleCodes: string[] = [],
): UserPayload {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    roleIds: idsToStrings(doc.roleIds),
    roleCodes,
    permissionGrants: toPermissions(doc.permissionGrants),
    permissionRevokes: toPermissions(doc.permissionRevokes),
    effectivePermissions: effective,
    locationIds: idsToStrings(doc.locationIds),
    defaultLocationId: idToString(doc.defaultLocationId),
    isActive: doc.isActive,
    mustChangePassword: doc.mustChangePassword,
    lastLoginAt: doc.lastLoginAt ? doc.lastLoginAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
