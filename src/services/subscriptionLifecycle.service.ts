import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { lifecycleStep } from '../domain/subscription.js';
import { addDays, dayIn } from '../lib/period.js';
import { Org } from '../modules/org/org.model.js';
import { PlatformAdmin } from '../modules/platform/platformAdmin.model.js';
import { platformDashboard } from '../modules/platform/platformTenant.service.js';
import { SubscriptionNotice } from '../modules/platform/subscriptionNotice.model.js';
import { User } from '../modules/user/user.model.js';
import { formatMoney } from '../shared/money.js';

import * as templates from './emailTemplates.js';
import { sendMail } from './mailer.service.js';
import { invalidateOrgAccess, planByCode } from './subscription.service.js';

import type { LifecycleNotice } from '../domain/subscription.js';
import type { SubscriptionNoticeKind } from '../modules/platform/subscriptionNotice.model.js';
import type { MailMessage } from './mailer.service.js';
import type { Types } from 'mongoose';

/**
 * The daily subscription job — SaaS phase 6. Run by `scripts/subscription-daily.ts` (cron / pm2).
 *
 * For every business that can still lapse it:
 *   1. writes PAST_DUE down once a trial or paid period has ended (the API already *treats* it as
 *      past due from that second — this makes the stored status, the lists and filters agree);
 *   2. emails the owner: 7 / 3 / 1 days before the end, on the day it ends, and when it turns
 *      read-only after the grace period;
 * then, once a week, emails the platform admins a summary.
 *
 * Safe to run as often as you like: each email is claimed in `subscription_notices` before it is
 * sent, so it goes out once; a failed send is released and retried on the next run.
 */

export interface LifecycleRunSummary {
  checked: number;
  markedPastDue: number;
  emailsSent: number;
  emailsFailed: number;
  /** Owner missing or inactive — nobody to tell. */
  skipped: number;
  weeklySummary: 'sent' | 'already-sent' | 'failed' | 'no-admins';
}

/** Claim a notice; false if this key was already claimed (sent, or being sent by another run). */
async function claim(
  key: string,
  kind: SubscriptionNoticeKind,
  orgId: Types.ObjectId | null,
  to: string[],
  now: Date,
): Promise<boolean> {
  try {
    await SubscriptionNotice.create({ key, kind, orgId, to, sentAt: now });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

async function release(key: string): Promise<void> {
  await SubscriptionNotice.deleteOne({ key });
}

/** Claim, send, and release on failure. */
async function sendOnce(
  key: string,
  kind: SubscriptionNoticeKind,
  orgId: Types.ObjectId | null,
  messages: MailMessage[],
  now: Date,
): Promise<'sent' | 'already-sent' | 'failed'> {
  if (!(await claim(key, kind, orgId, messages.map((m) => m.to), now))) return 'already-sent';
  let ok = true;
  for (const message of messages) ok = (await sendMail(message)) && ok;
  if (!ok) await release(key);
  return ok ? 'sent' : 'failed';
}

function noticeKey(orgId: Types.ObjectId, notice: LifecycleNotice, endsAt: Date): string {
  const stage = notice.kind === 'ENDING' ? `:${notice.stage}` : '';
  return `${String(orgId)}:${notice.kind}${stage}:${endsAt.toISOString()}`;
}

export interface LifecycleRunOptions {
  /** Only these businesses, and no weekly summary — for tests against a shared database. */
  orgIds?: Types.ObjectId[];
}

export async function runSubscriptionLifecycle(
  now = new Date(),
  options: LifecycleRunOptions = {},
): Promise<LifecycleRunSummary> {
  const summary: LifecycleRunSummary = {
    checked: 0,
    markedPastDue: 0,
    emailsSent: 0,
    emailsFailed: 0,
    skipped: 0,
    weeklySummary: 'already-sent',
  };

  const orgs = await Org.find({
    status: { $in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
    ...(options.orgIds ? { _id: { $in: options.orgIds } } : {}),
  })
    .select('name status planCode trialEndsAt currentPeriodEndsAt ownerUserId')
    .lean();

  for (const org of orgs) {
    summary.checked += 1;
    const step = lifecycleStep(
      {
        status: org.status,
        trialEndsAt: org.trialEndsAt ?? null,
        currentPeriodEndsAt: org.currentPeriodEndsAt ?? null,
      },
      now,
      config.saas.graceDays,
    );

    if (step.markPastDue) {
      // Conditional on what was read: a payment recorded in between wins, and is not overwritten.
      const res = await Org.updateOne(
        {
          _id: org._id,
          status: org.status,
          trialEndsAt: org.trialEndsAt ?? null,
          currentPeriodEndsAt: org.currentPeriodEndsAt ?? null,
        },
        { $set: { status: 'PAST_DUE' } },
      );
      if (res.modifiedCount) {
        summary.markedPastDue += 1;
        invalidateOrgAccess(org._id);
        logger.info({ orgId: String(org._id), was: org.status }, 'Subscription marked past due');
      } else {
        continue; // changed under us — tomorrow's run sees the new state
      }
    }

    if (!step.notice || !step.endsAt) continue;

    const owner = org.ownerUserId
      ? await User.findOne({ _id: org.ownerUserId, isActive: true }).select('name email').lean()
      : null;
    if (!owner) {
      summary.skipped += 1;
      continue;
    }

    const who = { to: owner.email, name: owner.name, businessName: org.name };
    const notice = step.notice;
    let message: MailMessage;
    if (notice.kind === 'ENDING') {
      const plan = await planByCode(org.planCode ?? null);
      message = templates.subscriptionEnding({
        ...who,
        isTrial: step.isTrial,
        daysLeft: notice.daysLeft,
        endsAt: step.endsAt,
        planName: plan?.name ?? null,
        priceMonthlyMinor: plan?.priceMonthlyMinor ?? null,
      });
    } else if (notice.kind === 'EXPIRED') {
      message = templates.subscriptionExpired({
        ...who,
        isTrial: step.isTrial,
        graceEndsAt: notice.graceEndsAt,
      });
    } else {
      message = templates.subscriptionReadOnly(who);
    }

    const result = await sendOnce(
      noticeKey(org._id, notice, step.endsAt),
      notice.kind,
      org._id,
      [message],
      now,
    );
    if (result === 'sent') summary.emailsSent += 1;
    if (result === 'failed') summary.emailsFailed += 1;
  }

  summary.weeklySummary = options.orgIds ? 'already-sent' : await sendWeeklySummary(now);
  return summary;
}

/** The Monday (app time zone) of the week `now` falls in, as `YYYY-MM-DD`. */
export function weekStartOf(now: Date): string {
  const day = dayIn(now, config.locale.timezone);
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/** Once a week — the first run on or after Monday — to every active platform admin. */
async function sendWeeklySummary(now: Date): Promise<LifecycleRunSummary['weeklySummary']> {
  const weekOf = weekStartOf(now);
  const key = `WEEKLY_SUMMARY:${weekOf}`;
  if (await SubscriptionNotice.exists({ key })) return 'already-sent';

  const admins = await PlatformAdmin.find({ isActive: true }).select('name email').lean();
  if (admins.length === 0) return 'no-admins';

  const d = await platformDashboard();
  const row = (t: { name: string; daysLeft: number | null }) =>
    `${t.name}${t.daysLeft !== null ? ` — ${t.daysLeft} day(s)` : ''}`;
  const lines = [
    `${d.tenants.total} businesses: ${d.tenants.TRIAL} on trial, ${d.tenants.ACTIVE} paying, ${d.tenants.PAST_DUE} payment due (${d.readOnly} read-only), ${d.tenants.SUSPENDED} suspended.`,
    `Revenue this month ${formatMoney(d.revenue.thisMonthMinor)} (last month ${formatMoney(d.revenue.lastMonthMinor)}). ${d.signupsThisMonth} sign-up(s) this month.`,
  ];
  const lists = [
    { heading: 'Trials ending in the next 7 days', items: d.trialsEndingSoon.map(row) },
    { heading: 'Payment due', items: d.overdue.map(row) },
    {
      heading: 'Waiting on a plan request',
      items: d.planRequests.map(
        (t) => `${t.name} → ${t.planRequest!.planName}, ${t.planRequest!.cycle.toLowerCase()}`,
      ),
    },
  ];

  return sendOnce(
    key,
    'WEEKLY_SUMMARY',
    null,
    admins.map((a) =>
      templates.weeklySummary({ to: a.email, adminName: a.name, weekOf, lines, lists }),
    ),
    now,
  );
}
