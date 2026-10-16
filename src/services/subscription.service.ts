import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { hasRoomFor, planHasFeature, planLimit, subscriptionState } from '../domain/subscription.js';
import { ApiError } from '../lib/ApiError.js';
import { Location } from '../modules/location/location.model.js';
import { Org } from '../modules/org/org.model.js';
import { Plan, toPlanPayload } from '../modules/plan/plan.model.js';
import { Product } from '../modules/product/product.model.js';
import { User } from '../modules/user/user.model.js';

import type { SubscriptionDates, SubscriptionState } from '../domain/subscription.js';
import type { LimitedResource, PlanFeature } from '@shared/enums.js';
import type { PlanPayload, SubscriptionPayload } from '@shared/types.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * Plans, limits and subscription status — SaaS phase 4.
 *
 * `orgAccess` runs on every authenticated request (from `authenticate`), so it is cached in memory
 * for a few seconds per business. Anything in this process that changes a business's status, dates
 * or plan calls `invalidateOrgAccess` so the change applies on the very next request. The API runs
 * as one process (pm2, one instance); with several, the worst case is the TTL below.
 */

const ACCESS_TTL_MS = 30_000;
const PLAN_TTL_MS = 60_000;

export interface OrgAccess {
  orgId: string;
  planCode: string | null;
  plan: PlanPayload | null;
  /** Computed from `stored` against the time of the call — never cached itself. */
  state: SubscriptionState;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
}

/** What is read from the database and cached: the stored fields, not the derived state. */
interface StoredAccess {
  planCode: string | null;
  plan: PlanPayload | null;
  dates: SubscriptionDates;
}

const accessCache = new Map<string, { value: StoredAccess; expires: number }>();
const planCache = new Map<string, { value: PlanPayload | null; expires: number }>();

export function invalidateOrgAccess(orgId: Types.ObjectId | string): void {
  accessCache.delete(String(orgId));
}

/** For tests, and for a platform admin editing a plan. */
export function invalidatePlans(): void {
  planCache.clear();
  accessCache.clear();
}

/**
 * The plan by code. An unknown code is treated as no plan — unlimited — but logged: it is a data
 * error (a plan deleted or mistyped), and failing open keeps a paying business working.
 */
export async function planByCode(code: string | null): Promise<PlanPayload | null> {
  if (!code) return null;
  const hit = planCache.get(code);
  if (hit && hit.expires > Date.now()) return hit.value;

  const doc = await Plan.findOne({ code }).lean();
  if (!doc) logger.error({ planCode: code }, 'A business points at a plan that does not exist');
  const value = doc ? toPlanPayload(doc) : null;
  planCache.set(code, { value, expires: Date.now() + PLAN_TTL_MS });
  return value;
}

async function storedAccess(orgId: string): Promise<StoredAccess> {
  const hit = accessCache.get(orgId);
  if (hit && hit.expires > Date.now()) return hit.value;

  const org = await Org.findById(orgId)
    .select('status planCode trialEndsAt currentPeriodEndsAt')
    .lean();
  if (!org) throw ApiError.unauthenticated('Invalid authentication token');

  const value: StoredAccess = {
    planCode: org.planCode ?? null,
    plan: await planByCode(org.planCode ?? null),
    dates: {
      status: org.status ?? 'ACTIVE',
      trialEndsAt: org.trialEndsAt ?? null,
      currentPeriodEndsAt: org.currentPeriodEndsAt ?? null,
    },
  };
  accessCache.set(orgId, { value, expires: Date.now() + ACCESS_TTL_MS });
  return value;
}

/** The business's plan and its subscription state *now*. Runs on every authenticated request. */
export async function orgAccess(orgId: Types.ObjectId | string, now = new Date()): Promise<OrgAccess> {
  const stored = await storedAccess(String(orgId));
  return {
    orgId: String(orgId),
    planCode: stored.planCode,
    plan: stored.plan,
    // Derived per call, so a cached trial still expires on the second it ends.
    state: subscriptionState(stored.dates, now, config.saas.graceDays),
    trialEndsAt: stored.dates.trialEndsAt,
    currentPeriodEndsAt: stored.dates.currentPeriodEndsAt,
  };
}

const LABELS: Record<LimitedResource, string> = {
  users: 'active users',
  locations: 'active locations',
  products: 'active products',
};

async function countInUse(
  orgId: Types.ObjectId,
  resource: LimitedResource,
  session?: ClientSession,
): Promise<number> {
  const filter = { orgId, isActive: true };
  const query =
    resource === 'users'
      ? User.countDocuments(filter)
      : resource === 'locations'
        ? Location.countDocuments(filter)
        : Product.countDocuments(filter);
  return query.session(session ?? null);
}

/**
 * Refuse one more user / location / product when the plan is full. Called before creating one, and
 * before reactivating one that was switched off — deactivating is how a business makes room.
 */
export async function assertWithinLimit(
  orgId: Types.ObjectId,
  resource: LimitedResource,
  session?: ClientSession,
): Promise<void> {
  const { plan } = await orgAccess(orgId);
  const limit = planLimit(plan, resource);
  if (limit === null) return;

  const used = await countInUse(orgId, resource, session);
  if (!hasRoomFor(plan, resource, used)) {
    throw ApiError.conflict(
      'PLAN_LIMIT_REACHED',
      `Your ${plan!.name} plan allows ${limit} ${LABELS[resource]}. Deactivate one, or upgrade your plan.`,
      { resource, limit, used, planCode: plan!.code },
    );
  }
}

export function assertFeature(access: OrgAccess, feature: PlanFeature): void {
  if (!planHasFeature(access.plan, feature)) {
    const names: Record<PlanFeature, string> = {
      POS: 'The counter POS',
      PURCHASING: 'Purchasing',
      REPORTS: 'The report suite',
    };
    throw new ApiError(
      403,
      'FEATURE_NOT_IN_PLAN',
      `${names[feature]} is not included in your ${access.plan!.name} plan. Upgrade to use it.`,
      { feature, planCode: access.planCode },
    );
  }
}

/** `GET /org/subscription` — the billing page and the status banner. */
export async function getSubscription(orgId: Types.ObjectId): Promise<SubscriptionPayload> {
  invalidateOrgAccess(orgId);
  const access = await orgAccess(orgId);
  const [users, locations, products] = await Promise.all([
    countInUse(orgId, 'users'),
    countInUse(orgId, 'locations'),
    countInUse(orgId, 'products'),
  ]);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  return {
    status: access.state.status,
    access: access.state.access,
    planCode: access.planCode,
    plan: access.plan,
    trialEndsAt: iso(access.trialEndsAt),
    currentPeriodEndsAt: iso(access.currentPeriodEndsAt),
    dueSince: iso(access.state.dueSince),
    graceEndsAt: iso(access.state.graceEndsAt),
    daysLeft: access.state.daysLeft,
    usage: { users, locations, products },
    paymentInstructions: config.saas.billingInstructions,
  };
}
