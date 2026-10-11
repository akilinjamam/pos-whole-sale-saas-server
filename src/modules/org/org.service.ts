import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { writeAudit } from '../../services/audit.service.js';

import { Org, toOrgPayload } from './org.model.js';

import type { UpdateOrgInput, UpdateOrgSettingsInput } from './org.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { OrgPayload } from '@shared/types.js';

/**
 * The org is read on nearly every posting path — `invoiceOnDispatch` on each dispatch,
 * `allowNegativeStock` on each movement, `enforceCreditLimit` on each confirm. Callers that
 * need the settings inside a transaction read the document; callers that need the profile for
 * display get the payload.
 *
 * Every change is audited (Day 39) in the same transaction as the write: who, when, from where,
 * and exactly which fields went from what to what.
 */

export async function getOrg(orgId: Types.ObjectId): Promise<OrgPayload> {
  const org = await Org.findById(orgId).lean();
  if (!org) throw ApiError.notFound('Organisation');
  return toOrgPayload(org);
}

/** The fields that actually changed, as `before` / `after` — an unchanged field is not news. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const was = before[key] ?? null;
    const now = after[key] ?? null;
    if (String(was) !== String(now)) {
      b[key] = was;
      a[key] = now;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

export async function updateOrg(
  actor: RequestActor,
  input: UpdateOrgInput,
): Promise<OrgPayload> {
  const org = await withTransaction(async (session) => {
    const before = await Org.findById(actor.orgId).session(session).lean();
    if (!before) throw ApiError.notFound('Organisation');
    const updated = await Org.findByIdAndUpdate(
      actor.orgId,
      { $set: { ...input, updatedBy: actor.actorId } },
      { new: true, runValidators: true, session },
    ).lean();
    const changed = diff(before as unknown as Record<string, unknown>, input);
    if (changed) {
      await writeAudit(session, actor, {
        action: 'ORG_PROFILE_CHANGE',
        entity: 'Org',
        entityId: actor.orgId,
        ...changed,
      });
    }
    return updated!;
  });
  return toOrgPayload(org);
}

export async function updateOrgSettings(
  actor: RequestActor,
  input: UpdateOrgSettingsInput,
): Promise<OrgPayload> {
  // Dot-path `$set` so a partial update touches only the flags named, rather than replacing
  // the whole subdocument and resetting the ones the client did not send.
  const set: Record<string, unknown> = { updatedBy: actor.actorId };
  for (const [key, value] of Object.entries(input)) {
    set[`settings.${key}`] =
      key === 'defaultRetailTierId' && typeof value === 'string'
        ? new Types.ObjectId(value)
        : value;
  }

  const org = await withTransaction(async (session) => {
    const before = await Org.findById(actor.orgId).select('settings').session(session).lean();
    if (!before) throw ApiError.notFound('Organisation');
    const updated = await Org.findByIdAndUpdate(
      actor.orgId,
      { $set: set },
      { new: true, runValidators: true, session },
    ).lean();
    const changed = diff(before.settings as unknown as Record<string, unknown>, input);
    if (changed) {
      await writeAudit(session, actor, {
        action: 'SETTINGS_CHANGE',
        entity: 'Org',
        entityId: actor.orgId,
        ...changed,
      });
    }
    return updated!;
  });
  return toOrgPayload(org);
}
