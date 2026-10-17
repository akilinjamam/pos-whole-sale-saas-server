import { Schema, model } from 'mongoose';

import type { Model, Types } from 'mongoose';

/**
 * Every platform-admin action — SaaS phase 5. Who did what to which business, from where, and what
 * changed. Platform-level (no `orgId` to scope it, though `targetOrgId` names the business acted on),
 * append-only, read by the platform only.
 */

export const PLATFORM_AUDIT_ACTIONS = [
  'ADMIN_LOGIN',
  'TENANT_CREATE',
  'TENANT_SUSPEND',
  'TENANT_REACTIVATE',
  'TENANT_CANCEL',
  'TENANT_PLAN_CHANGE',
  'TENANT_PLAN_REQUEST_DISMISS',
  'TENANT_TRIAL_EXTEND',
  'PAYMENT_RECORD',
  'PLAN_CREATE',
  'PLAN_UPDATE',
  'ADMIN_CREATE',
  'ADMIN_UPDATE',
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface PlatformAuditLogDoc {
  _id: Types.ObjectId;
  at: Date;
  adminId: Types.ObjectId;
  action: PlatformAuditAction;
  targetOrgId: Types.ObjectId | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

const platformAuditLogSchema = new Schema<PlatformAuditLogDoc>(
  {
    at: { type: Date, required: true, default: () => new Date() },
    adminId: { type: Schema.Types.ObjectId, ref: 'PlatformAdmin', required: true },
    action: { type: String, enum: PLATFORM_AUDIT_ACTIONS, required: true },
    targetOrgId: { type: Schema.Types.ObjectId, ref: 'Org', default: null },
    details: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { versionKey: false, collection: 'platform_audit_logs' },
);

platformAuditLogSchema.index({ at: -1 });
platformAuditLogSchema.index({ targetOrgId: 1, at: -1 });

export const PlatformAuditLog: Model<PlatformAuditLogDoc> = model<PlatformAuditLogDoc>(
  'PlatformAuditLog',
  platformAuditLogSchema,
);
