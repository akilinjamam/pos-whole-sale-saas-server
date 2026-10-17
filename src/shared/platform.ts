/**
 * The platform-admin contract (SaaS phase 5) — the people who run the service, not the businesses
 * that use it.
 *
 * Kept apart from `permissions.ts` on purpose: a platform permission is not a `Permission`, so a
 * tenant route cannot be gated on one by mistake, and no tenant role can ever be granted one — the
 * role editor only offers the tenant catalog.
 */

import type { LimitedResource, OrgStatus, SubscriptionAccess } from './enums.js';
import type { PlanPayload, PlanRequestPayload } from './types.js';

type Member<T extends readonly string[]> = T[number];

export const PLATFORM_PERMISSIONS = [
  /** See and manage businesses: create, suspend, reactivate, cancel, change plan, extend trial. */
  'platform:tenants',
  /** Record subscription payments and read them. */
  'platform:billing',
  /** Edit the plans and their prices. */
  'platform:plans',
  /** Add, edit and disable platform admins. */
  'platform:admins',
] as const;
export type PlatformPermission = Member<typeof PLATFORM_PERMISSIONS>;

/** How a business paid. Manual entry for now; a gateway (phase 10) adds its own. */
export const SUBSCRIPTION_PAYMENT_METHODS = [
  'BKASH',
  'NAGAD',
  'BANK',
  'CASH',
  'OTHER',
] as const;
export type SubscriptionPaymentMethod = Member<typeof SUBSCRIPTION_PAYMENT_METHODS>;

export interface PlatformAdminPayload {
  id: string;
  name: string;
  email: string;
  permissions: PlatformPermission[];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PlatformLoginResponse {
  accessToken: string;
  /** Seconds. There is no refresh token: an admin signs in again when it runs out. */
  expiresIn: number;
  admin: PlatformAdminPayload;
}

/** One row of the businesses list. `status` and `access` are the effective ones. */
export interface TenantSummaryPayload {
  id: string;
  name: string;
  slug: string | null;
  status: OrgStatus;
  access: SubscriptionAccess;
  planCode: string | null;
  planName: string | null;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  /** Whole days until the trial / period ends, or until read-only once past due. */
  daysLeft: number | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerEmailVerified: boolean;
  usage: Record<LimitedResource, number>;
  /** The most recent sign-in by anyone in the business. */
  lastActiveAt: string | null;
  signupSource: string;
  createdAt: string;
  /** A plan the business has asked for, waiting for the platform to act. */
  planRequest: PlanRequestPayload | null;
}

export interface SubscriptionPaymentPayload {
  id: string;
  receiptNo: string;
  orgId: string;
  orgName: string;
  amountMinor: number;
  method: SubscriptionPaymentMethod;
  trxId: string | null;
  months: number;
  planCode: string;
  periodStart: string;
  periodEnd: string;
  paidAt: string;
  note: string | null;
  recordedByName: string | null;
  createdAt: string;
}

export interface PlatformAuditPayload {
  id: string;
  at: string;
  action: string;
  adminName: string | null;
  orgId: string | null;
  orgName: string | null;
  details: Record<string, unknown> | null;
}

export interface TenantDetailPayload extends TenantSummaryPayload {
  legalName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  dueSince: string | null;
  graceEndsAt: string | null;
  plan: PlanPayload | null;
  payments: SubscriptionPaymentPayload[];
  audit: PlatformAuditPayload[];
}

/** A plan as the platform sees it — with the switch and order the public never sees. */
export interface PlatformPlanPayload extends PlanPayload {
  isActive: boolean;
  sortOrder: number;
  /** How many businesses are on it now. */
  tenants: number;
}

export interface PlatformDashboardPayload {
  tenants: Record<OrgStatus, number> & { total: number };
  /** Read-only now: past due beyond the grace period. */
  readOnly: number;
  revenue: { thisMonthMinor: number; lastMonthMinor: number; last12MonthsMinor: number };
  signupsThisMonth: number;
  trialsEndingSoon: TenantSummaryPayload[];
  overdue: TenantSummaryPayload[];
  /** Businesses waiting for an answer to a plan request, oldest first. */
  planRequests: TenantSummaryPayload[];
  recentPayments: SubscriptionPaymentPayload[];
}
