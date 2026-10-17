import { config } from '../../config/env.js';
import { ApiError } from '../../lib/ApiError.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { writeAudit } from '../../services/audit.service.js';
import * as templates from '../../services/emailTemplates.js';
import { sendMail } from '../../services/mailer.service.js';
import { getSubscription, invalidateOrgAccess } from '../../services/subscription.service.js';
import { PlatformAdmin } from '../platform/platformAdmin.model.js';
import { User } from '../user/user.model.js';

import { Org } from './org.model.js';

import type { CloseOrgInput } from './org.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { SubscriptionPayload } from '@shared/types.js';

const DAY_MS = 86_400_000;

/**
 * `POST /org/close` — the owner closes their business (SaaS phase 7).
 *
 * Only the owner — not anyone holding `org:update` — and only with the business's name typed out
 * and their password, because the end of it is deletion. The business becomes CANCELLED at once
 * (everyone is shut out by the subscription check); its data is kept for `PURGE_AFTER_DAYS`, during
 * which the owner can still sign in and export it, and the platform can reactivate it.
 */
export async function closeOrg(
  actor: RequestActor,
  input: CloseOrgInput,
): Promise<SubscriptionPayload> {
  const org = await Org.findById(actor.orgId).select('name status ownerUserId').lean();
  if (!org) throw ApiError.notFound('Organisation');
  if (String(org.ownerUserId) !== String(actor.actorId)) {
    throw ApiError.forbidden('Only the owner of the business can close it');
  }
  if (org.status === 'CANCELLED') {
    throw ApiError.conflict('ILLEGAL_TRANSITION', 'This business is already closed');
  }

  const fields: { path: string; message: string }[] = [];
  if (input.businessName.trim().toLowerCase() !== org.name.trim().toLowerCase()) {
    fields.push({ path: 'businessName', message: 'Type the business name exactly as shown' });
  }
  const owner = await User.findById(actor.actorId).select('+passwordHash name email');
  if (!owner || !(await owner.verifyPassword(input.password))) {
    fields.push({ path: 'password', message: 'Wrong password' });
  }
  if (fields.length) throw ApiError.validation('Validation failed', fields);

  const now = new Date();
  const purgeAfter = new Date(now.getTime() + config.saas.purgeAfterDays * DAY_MS);
  const reason = input.reason?.trim() || null;

  await withTransaction(async (session) => {
    // Conditional, so two clicks (or a platform action in between) cannot both apply.
    const res = await Org.updateOne(
      { _id: actor.orgId, status: org.status },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: now,
          purgeAfter,
          cancellationReason: reason,
          cancelledBy: 'OWNER',
          updatedBy: actor.actorId,
        },
      },
      { session },
    );
    if (!res.modifiedCount) {
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'The business changed — reload and try again');
    }
    await writeAudit(session, actor, {
      action: 'ORG_CLOSE',
      entity: 'Org',
      entityId: actor.orgId,
      reason,
      before: { status: org.status },
      after: { status: 'CANCELLED', purgeAfter: purgeAfter.toISOString() },
    });
  });
  invalidateOrgAccess(actor.orgId);

  // After the commit. Failures are logged by the mailer; the closing stands.
  await sendMail(
    templates.accountClosed({
      to: owner!.email,
      name: owner!.name,
      businessName: org.name,
      purgeAfter,
    }),
  );
  const admins = await PlatformAdmin.find({
    isActive: true,
    permissions: 'platform:tenants',
  })
    .select('name email')
    .lean();
  for (const admin of admins) {
    await sendMail(
      templates.businessClosedByOwner({
        to: admin.email,
        adminName: admin.name,
        orgId: String(actor.orgId),
        businessName: org.name,
        ownerEmail: owner!.email,
        reason,
        purgeAfter,
      }),
    );
  }

  return getSubscription(actor.orgId);
}
