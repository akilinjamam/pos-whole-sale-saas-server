import { Schema, model } from 'mongoose';

import { AUDIT_ACTIONS } from '../../shared/enums.js';

import type { AuditAction } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * The audit log — §6.11. Who did what that someone will later need to answer for, and why.
 *
 * **Append-only**, like the ledger: there is no update or delete route, and the model refuses
 * them. An entry is written in the same transaction as the act it records (`services/audit`), so
 * an override that happened always has its entry, and an entry always describes something that
 * happened.
 *
 * Day 31 writes credit overrides. Day 39 adds the viewer and the other actions.
 */
export interface AuditLogDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  at: Date;
  actorUserId: Types.ObjectId | null;
  actorName: string | null;
  action: AuditAction;
  entity: string;
  entityId: Types.ObjectId | null;
  docNo: string | null;
  /** The person's own words — mandatory for an override. */
  reason: string | null;
  /** The state that was overruled, and what was done instead. Shape per action. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    at: { type: Date, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: null },
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    docNo: { type: String, default: null },
    reason: { type: String, trim: true, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null },
  },
  { collection: 'audit_logs', versionKey: false },
);

for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  auditLogSchema.pre(op, function refuse() {
    throw new Error(`AuditLog is append-only: ${op} is not allowed.`);
  });
}

// Newest first with a tie-break, so the log pages from the index (Day 40 review).
auditLogSchema.index({ orgId: 1, at: -1, _id: -1 });
auditLogSchema.index({ orgId: 1, action: 1, at: -1 });
auditLogSchema.index({ orgId: 1, entity: 1, entityId: 1, at: -1 });

export const AuditLog: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);
