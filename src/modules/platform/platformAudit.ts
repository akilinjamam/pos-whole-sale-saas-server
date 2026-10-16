import { PlatformAuditLog } from './platformAuditLog.model.js';

import type { PlatformAuditAction } from './platformAuditLog.model.js';
import type { PlatformAdminDoc } from './platformAdmin.model.js';
import type { Request } from 'express';
import type { ClientSession, Types } from 'mongoose';

/** Who is acting on the platform, and from where — passed into every platform service call. */
export interface PlatformActor {
  admin: PlatformAdminDoc;
  ip: string | null;
  userAgent: string | null;
}

export function platformActorOf(req: Request): PlatformActor {
  if (!req.platformAdmin)
    throw new Error('platformActorOf called outside authenticatePlatform');
  return {
    admin: req.platformAdmin,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

/** Append one row to the platform audit log — in the caller's transaction when it has one. */
export async function writePlatformAudit(
  actor: PlatformActor,
  action: PlatformAuditAction,
  targetOrgId: Types.ObjectId | null,
  details: Record<string, unknown> | null,
  session?: ClientSession,
): Promise<void> {
  await PlatformAuditLog.create(
    [
      {
        at: new Date(),
        adminId: actor.admin._id,
        action,
        targetOrgId,
        details,
        ip: actor.ip,
        userAgent: actor.userAgent,
      },
    ],
    { session },
  );
}
