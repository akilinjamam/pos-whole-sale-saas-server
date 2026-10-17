import type {
  LimitedResource,
  OrgStatus,
  PlanFeature,
  SubscriptionAccess,
} from '@shared/enums.js';

/**
 * Subscription rules that need no database — SaaS phase 4.
 *
 * The **effective** state is computed from the stored status and dates on every check, so the
 * moment a trial's end passes it reads PAST_DUE, whether or not the daily job (phase 6) has yet
 * written that down. Access follows from it:
 *
 *   TRIAL / ACTIVE, not yet ended     → FULL
 *   ended, within the grace period    → FULL      (status PAST_DUE — the banner says pay now)
 *   ended, past the grace period      → READ_ONLY (status PAST_DUE — changes refused with 402)
 *   SUSPENDED / CANCELLED             → BLOCKED   (refused with 403)
 *
 * An ACTIVE business with no `currentPeriodEndsAt` never expires — that is the business that
 * predates SaaS, and anything a platform admin deliberately leaves open-ended.
 */

const DAY_MS = 86_400_000;

export interface SubscriptionDates {
  status: OrgStatus;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
}

export interface SubscriptionState {
  /** The effective status — may be PAST_DUE while the stored one still says TRIAL or ACTIVE. */
  status: OrgStatus;
  access: SubscriptionAccess;
  dueSince: Date | null;
  graceEndsAt: Date | null;
  /** Whole days until the trial / period ends — or, once past due, until the grace period ends. */
  daysLeft: number | null;
}

/** Whole days from `now` to `until`, rounded up, never negative. */
function daysUntil(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
}

/**
 * The date this subscription runs until. A trial runs to its trial end; anything else to the end of
 * the period paid for — or, for a business marked PAST_DUE straight from a trial, the trial end.
 */
export function subscriptionEndsAt(org: SubscriptionDates): Date | null {
  return org.status === 'TRIAL' ? org.trialEndsAt : (org.currentPeriodEndsAt ?? org.trialEndsAt);
}

export function subscriptionState(
  org: SubscriptionDates,
  now: Date,
  graceDays: number,
): SubscriptionState {
  if (org.status === 'SUSPENDED' || org.status === 'CANCELLED') {
    return {
      status: org.status,
      access: 'BLOCKED',
      dueSince: null,
      graceEndsAt: null,
      daysLeft: null,
    };
  }

  const endsAt = subscriptionEndsAt(org);

  if (!endsAt) {
    // Open-ended. PAST_DUE with no date at all is a platform admin's call — treat it as overdue.
    return org.status === 'PAST_DUE'
      ? {
          status: 'PAST_DUE',
          access: 'READ_ONLY',
          dueSince: null,
          graceEndsAt: null,
          daysLeft: 0,
        }
      : {
          status: org.status,
          access: 'FULL',
          dueSince: null,
          graceEndsAt: null,
          daysLeft: null,
        };
  }

  if (endsAt.getTime() > now.getTime() && org.status !== 'PAST_DUE') {
    return {
      status: org.status,
      access: 'FULL',
      dueSince: null,
      graceEndsAt: null,
      daysLeft: daysUntil(endsAt, now),
    };
  }

  const graceEndsAt = new Date(endsAt.getTime() + graceDays * DAY_MS);
  const inGrace = now.getTime() < graceEndsAt.getTime();
  return {
    status: 'PAST_DUE',
    access: inGrace ? 'FULL' : 'READ_ONLY',
    dueSince: endsAt,
    graceEndsAt,
    daysLeft: daysUntil(graceEndsAt, now),
  };
}

// ─── The daily lifecycle job (SaaS phase 6) ─────────────────────────────────────────────

/** Reminders go out when this many days or fewer are left — the most urgent stage reached. */
export const REMINDER_DAYS = [7, 3, 1] as const;
export type ReminderStage = (typeof REMINDER_DAYS)[number];

export type LifecycleNotice =
  | { kind: 'ENDING'; stage: ReminderStage; daysLeft: number }
  | { kind: 'EXPIRED'; graceEndsAt: Date }
  | { kind: 'READ_ONLY' };

export interface LifecycleStep {
  /** Write PAST_DUE down: the stored status still says TRIAL / ACTIVE after the end date. */
  markPastDue: boolean;
  /** The end date the notice is about — part of its key, so a renewal starts the reminders over. */
  endsAt: Date | null;
  /** Never paid: a trial, or past due straight from one. Changes the wording, not the rules. */
  isTrial: boolean;
  notice: LifecycleNotice | null;
}

/**
 * What the daily job should do for one business, now. Pure, so the job itself only carries it out.
 *
 * It names the **current** stage, not every stage passed: a job that missed a few days sends the
 * one reminder that is true today ("1 day left"), not three at once. The job sends each
 * (business, end date, notice) once, however often it runs.
 */
export function lifecycleStep(org: SubscriptionDates, now: Date, graceDays: number): LifecycleStep {
  const endsAt = subscriptionEndsAt(org);
  const isTrial =
    org.status === 'TRIAL' || (org.status === 'PAST_DUE' && !org.currentPeriodEndsAt);
  const none: LifecycleStep = { markPastDue: false, endsAt, isTrial, notice: null };

  if (org.status === 'SUSPENDED' || org.status === 'CANCELLED' || !endsAt) return none;

  if (endsAt.getTime() > now.getTime() && org.status !== 'PAST_DUE') {
    const daysLeft = daysUntil(endsAt, now);
    const stage = [...REMINDER_DAYS].reverse().find((d) => daysLeft <= d);
    return stage ? { ...none, notice: { kind: 'ENDING', stage, daysLeft } } : none;
  }

  const graceEndsAt = new Date(endsAt.getTime() + graceDays * DAY_MS);
  return {
    ...none,
    markPastDue: org.status !== 'PAST_DUE',
    notice:
      now.getTime() >= graceEndsAt.getTime()
        ? { kind: 'READ_ONLY' }
        : { kind: 'EXPIRED', graceEndsAt },
  };
}

/** Methods that only read. A READ_ONLY business may still make these. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a plan grants, in the shape the checks need. `null` — no plan — grants everything. */
export interface PlanRules {
  limits: Record<LimitedResource, number | null>;
  features: readonly PlanFeature[];
}

export function planHasFeature(plan: PlanRules | null, feature: PlanFeature): boolean {
  return plan === null || plan.features.includes(feature);
}

/** The cap on a resource, or `null` for unlimited. */
export function planLimit(plan: PlanRules | null, resource: LimitedResource): number | null {
  return plan === null ? null : plan.limits[resource];
}

/** Whether one more of `resource` fits, given how many are in use now. */
export function hasRoomFor(
  plan: PlanRules | null,
  resource: LimitedResource,
  used: number,
): boolean {
  const limit = planLimit(plan, resource);
  return limit === null || used < limit;
}

// ─── Payments (SaaS phase 5) ────────────────────────────────────────────────────────────

/**
 * `date` plus whole calendar months, in UTC. A day past the end of the target month is clamped to
 * its last day — 31 January + 1 month is 28 (or 29) February, not 3 March.
 */
export function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/**
 * The period a payment of `months` buys. It starts where the business's paid time — or unused
 * trial — runs out, if that is still ahead; otherwise now. Paying early never loses days, and
 * paying late does not back-date the new period over time the business was not paying for.
 */
export function paymentPeriod(
  org: SubscriptionDates,
  now: Date,
  months: number,
): { start: Date; end: Date } {
  const ahead = [org.currentPeriodEndsAt, org.status === 'TRIAL' ? org.trialEndsAt : null]
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const start = ahead ?? now;
  return { start, end: addMonths(start, months) };
}
