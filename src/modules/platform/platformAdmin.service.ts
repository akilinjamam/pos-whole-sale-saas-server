import type { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { signPlatformToken } from '../../lib/platformTokens.js';

import { PlatformAdmin, toPlatformAdminPayload } from './platformAdmin.model.js';
import { writePlatformAudit } from './platformAudit.js';

import type { PlatformActor } from './platformAudit.js';
import type {
  CreateAdminInput,
  PlatformLoginInput,
  PlatformPasswordInput,
  UpdateAdminInput,
} from './platform.schema.js';
import type { PlatformAdminPayload, PlatformLoginResponse } from '@shared/platform.js';

/** Platform-admin sign-in and the admin accounts themselves — SaaS phase 5. */

function invalidCredentials(): ApiError {
  return new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
}

export async function platformLogin(
  input: PlatformLoginInput,
  context: { ip: string | null; userAgent: string | null },
): Promise<PlatformLoginResponse> {
  const admin = await PlatformAdmin.findOne({ email: input.email }).select('+passwordHash');
  if (!admin || !(await admin.verifyPassword(input.password))) throw invalidCredentials();
  if (!admin.isActive) {
    throw new ApiError(401, 'ACCOUNT_DISABLED', 'This account has been disabled');
  }

  admin.lastLoginAt = new Date();
  await admin.save();
  await writePlatformAudit({ admin: admin.toObject(), ...context }, 'ADMIN_LOGIN', null, null);

  return {
    ...signPlatformToken(String(admin._id), admin.tokenVersion),
    admin: toPlatformAdminPayload(admin.toObject()),
  };
}

/** Ends every session this admin holds, on every device. */
export async function platformLogout(actor: PlatformActor): Promise<void> {
  await PlatformAdmin.updateOne({ _id: actor.admin._id }, { $inc: { tokenVersion: 1 } });
}

export async function changePlatformPassword(
  actor: PlatformActor,
  input: PlatformPasswordInput,
): Promise<PlatformLoginResponse> {
  const admin = await PlatformAdmin.findById(actor.admin._id).select('+passwordHash');
  if (!admin) throw ApiError.unauthenticated();
  if (!(await admin.verifyPassword(input.currentPassword))) {
    throw ApiError.validation('Validation failed', [
      { path: 'currentPassword', message: 'That is not your current password' },
    ]);
  }
  admin.passwordHash = input.newPassword; // hashed by the pre-save hook
  admin.mustChangePassword = false;
  admin.tokenVersion += 1;
  await admin.save();

  // A fresh token, so changing the password does not sign the admin out of this tab.
  return {
    ...signPlatformToken(String(admin._id), admin.tokenVersion),
    admin: toPlatformAdminPayload(admin.toObject()),
  };
}

export async function listAdmins(): Promise<PlatformAdminPayload[]> {
  const admins = await PlatformAdmin.find().sort({ name: 1 }).lean();
  return admins.map(toPlatformAdminPayload);
}

export async function createAdmin(
  actor: PlatformActor,
  input: CreateAdminInput,
): Promise<PlatformAdminPayload> {
  if (await PlatformAdmin.exists({ email: input.email })) {
    throw ApiError.conflict('EMAIL_TAKEN', 'A platform admin with this email already exists', {
      field: 'email',
    });
  }
  const admin = new PlatformAdmin({
    name: input.name,
    email: input.email,
    passwordHash: input.password,
    permissions: input.permissions,
    mustChangePassword: true,
    createdBy: actor.admin._id,
  });
  await admin.save();
  await writePlatformAudit(actor, 'ADMIN_CREATE', null, {
    adminId: String(admin._id),
    email: admin.email,
    permissions: admin.permissions,
  });
  return toPlatformAdminPayload(admin.toObject());
}

/**
 * Edit an admin. An admin cannot disable themselves or take away their own `platform:admins` —
 * that is how the last person able to fix a mistake locks everyone out.
 */
export async function updateAdmin(
  actor: PlatformActor,
  id: Types.ObjectId,
  input: UpdateAdminInput,
): Promise<PlatformAdminPayload> {
  const self = String(id) === String(actor.admin._id);
  if (self && input.isActive === false) {
    throw ApiError.conflict('VALIDATION_FAILED', 'You cannot disable your own account');
  }
  if (self && input.permissions && !input.permissions.includes('platform:admins')) {
    throw ApiError.conflict('VALIDATION_FAILED', 'You cannot remove your own admin permission');
  }

  const admin = await PlatformAdmin.findById(id).select('+passwordHash');
  if (!admin) throw ApiError.notFound('Platform admin');

  const before = {
    name: admin.name,
    permissions: [...admin.permissions],
    isActive: admin.isActive,
  };
  if (input.name !== undefined) admin.name = input.name;
  if (input.permissions !== undefined) admin.permissions = input.permissions;
  if (input.isActive !== undefined) admin.isActive = input.isActive;
  if (input.password !== undefined) {
    admin.passwordHash = input.password;
    admin.mustChangePassword = true;
  }
  if (
    input.permissions !== undefined ||
    input.isActive !== undefined ||
    input.password !== undefined
  ) {
    admin.tokenVersion += 1;
  }
  await admin.save();

  await writePlatformAudit(actor, 'ADMIN_UPDATE', null, {
    adminId: String(admin._id),
    before,
    after: { name: admin.name, permissions: admin.permissions, isActive: admin.isActive },
    passwordReset: input.password !== undefined,
  });
  return toPlatformAdminPayload(admin.toObject());
}
