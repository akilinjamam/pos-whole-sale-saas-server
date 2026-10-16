import type { LimitedResource, OrgStatus, PlanFeature, SubscriptionAccess } from '@shared/enums.js';

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

export function subscriptionState(
  org: SubscriptionDates,
  now: Date,
  graceDays: number,
): SubscriptionState {
  if (org.status === 'SUSPENDED' || org.status === 'CANCELLED') {
    return { status: org.status, access: 'BLOCKED', dueSince: null, graceEndsAt: null, daysLeft: null };
  }

  // The date this subscription runs until. A trial runs to its trial end; anything else to the
  // end of the period paid for — or, for a business marked PAST_DUE straight from a trial, the
  // trial end.
  const endsAt =
    org.status === 'TRIAL' ? org.trialEndsAt : (org.currentPeriodEndsAt ?? org.trialEndsAt);

  if (!endsAt) {
    // Open-ended. PAST_DUE with no date at all is a platform admin's call — treat it as overdue.
    return org.status === 'PAST_DUE'
      ? { status: 'PAST_DUE', access: 'READ_ONLY', dueSince: null, graceEndsAt: null, daysLeft: 0 }
      : { status: org.status, access: 'FULL', dueSince: null, graceEndsAt: null, daysLeft: null };
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
export function hasRoomFor(plan: PlanRules | null, resource: LimitedResource, used: number): boolean {
  const limit = planLimit(plan, resource);
  return limit === null || used < limit;
}
