import { Types } from 'mongoose';

import { config } from '../../config/env.js';
import { paymentPeriod, subscriptionState } from '../../domain/subscription.js';
import { ApiError } from '../../lib/ApiError.js';
import { escapeRegex } from '../../lib/paginate.js';
import { nextSequence } from '../../lib/numbering.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { provisionOrg } from '../../services/provisioning.service.js';
import {
  invalidateOrgAccess,
  planByCode,
  toPlanRequestPayload,
} from '../../services/subscription.service.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Plan } from '../plan/plan.model.js';
import { Product } from '../product/product.model.js';
import { User } from '../user/user.model.js';

import { PlatformAdmin } from './platformAdmin.model.js';
import { PlatformAuditLog } from './platformAuditLog.model.js';
import { writePlatformAudit } from './platformAudit.js';
import { SubscriptionPayment } from './subscriptionPayment.model.js';

import type { PlatformActor } from './platformAudit.js';
import type {
  ChangePlanInput,
  CreateTenantInput,
  ExtendTrialInput,
  ListPaymentsQuery,
  ListTenantsQuery,
  ReasonInput,
  RecordPaymentInput,
} from './platform.schema.js';
import type { SubscriptionPaymentDoc } from './subscriptionPayment.model.js';
import type { OrgDoc } from '../org/org.model.js';
import type { LimitedResource, OrgStatus } from '@shared/enums.js';
import type {
  PlatformAuditPayload,
  PlatformDashboardPayload,
  SubscriptionPaymentPayload,
  TenantDetailPayload,
  TenantSummaryPayload,
} from '@shared/platform.js';
import type { PageMeta } from '@shared/types.js';

/**
 * The businesses on the platform, as the platform admin sees and manages them — SaaS phase 5.
 *
 * Every change is audited (`PlatformAuditLog`) and followed by `invalidateOrgAccess`, so the
 * business feels it on its very next request rather than when the access cache expires.
 *
 * Lists are built in memory: the effective status (a trial past its end reads PAST_DUE) is computed,
 * not stored, so it cannot be filtered on in the database. Comfortable for thousands of businesses;
 * the daily job (phase 6) writes the status down, after which filtering can move into the query.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const DAY_MS = 86_400_000;

type OrgRow = Pick<
  OrgDoc,
  | '_id'
  | 'name'
  | 'slug'
  | 'status'
  | 'planCode'
  | 'trialEndsAt'
  | 'currentPeriodEndsAt'
  | 'ownerUserId'
  | 'signupSource'
  | 'createdAt'
  | 'planRequest'
>;

const SUMMARY_FIELDS =
  'name slug status planCode trialEndsAt currentPeriodEndsAt ownerUserId signupSource createdAt planRequest';

/** Counts per business for one collection, in one query. */
async function countByOrg(
  model: typeof User | typeof Location | typeof Product,
  orgIds: Types.ObjectId[],
): Promise<Map<string, number>> {
  const rows = await (model as typeof User).aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { orgId: { $in: orgIds }, isActive: true } },
    { $group: { _id: '$orgId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function summaries(orgs: OrgRow[], now = new Date()): Promise<TenantSummaryPayload[]> {
  if (orgs.length === 0) return [];
  const ids = orgs.map((o) => o._id);

  const [users, locations, products, lastActive, owners, plans] = await Promise.all([
    countByOrg(User, ids),
    countByOrg(Location, ids),
    countByOrg(Product, ids),
    User.aggregate<{ _id: Types.ObjectId; at: Date | null }>([
      { $match: { orgId: { $in: ids } } },
      { $group: { _id: '$orgId', at: { $max: '$lastLoginAt' } } },
    ]),
    User.find({ _id: { $in: orgs.flatMap((o) => (o.ownerUserId ? [o.ownerUserId] : [])) } })
      .select('name email emailVerifiedAt')
      .lean(),
    Plan.find().select('code name').lean(),
  ]);
  const activeAt = new Map(lastActive.map((r) => [String(r._id), r.at]));
  const ownerBy = new Map(owners.map((u) => [String(u._id), u]));
  const planName = new Map(plans.map((p) => [p.code, p.name]));

  return orgs.map((o) => {
    const key = String(o._id);
    const state = subscriptionState(
      {
        status: o.status ?? 'ACTIVE',
        trialEndsAt: o.trialEndsAt ?? null,
        currentPeriodEndsAt: o.currentPeriodEndsAt ?? null,
      },
      now,
      config.saas.graceDays,
    );
    const owner = o.ownerUserId ? ownerBy.get(String(o.ownerUserId)) : undefined;
    const usage: Record<LimitedResource, number> = {
      users: users.get(key) ?? 0,
      locations: locations.get(key) ?? 0,
      products: products.get(key) ?? 0,
    };
    return {
      id: key,
      name: o.name,
      slug: o.slug ?? null,
      status: state.status,
      access: state.access,
      planCode: o.planCode ?? null,
      planName: o.planCode ? (planName.get(o.planCode) ?? o.planCode) : null,
      trialEndsAt: iso(o.trialEndsAt),
      currentPeriodEndsAt: iso(o.currentPeriodEndsAt),
      daysLeft: state.daysLeft,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      ownerEmailVerified: Boolean(owner?.emailVerifiedAt),
      usage,
      lastActiveAt: iso(activeAt.get(key) ?? null),
      signupSource: o.signupSource ?? 'SEED',
      createdAt: o.createdAt.toISOString(),
      planRequest: toPlanRequestPayload(
        o.planRequest,
        o.planRequest ? planName.get(o.planRequest.planCode) : null,
      ),
    };
  });
}

export async function listTenants(
  query: ListTenantsQuery,
): Promise<{ items: TenantSummaryPayload[]; meta: PageMeta }> {
  const filter: Record<string, unknown> = {};
  if (query.planCode) filter.planCode = query.planCode;
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    const owners = await User.find({ email: rx }).select('orgId').lean();
    filter.$or = [{ name: rx }, { slug: rx }, { _id: { $in: owners.map((u) => u.orgId) } }];
  }

  const orgs = await Org.find(filter).select(SUMMARY_FIELDS).lean<OrgRow[]>();
  let rows = await summaries(orgs);
  if (query.status) rows = rows.filter((r) => r.status === query.status);
  if (query.readOnly !== undefined)
    rows = rows.filter((r) => (r.access === 'READ_ONLY') === query.readOnly);

  const dir = query.order === 'desc' ? -1 : 1;
  const sortKey = (query.sort ?? 'createdAt') as keyof TenantSummaryPayload;
  const sortable = new Set(['name', 'createdAt', 'daysLeft', 'lastActiveAt', 'status']);
  const by = sortable.has(sortKey) ? sortKey : 'createdAt';
  const defaultDir = query.sort ? dir : -1; // newest first unless asked otherwise
  rows.sort((x, y) => {
    const a = x[by] ?? '';
    const b = y[by] ?? '';
    return (a < b ? -1 : a > b ? 1 : 0) * defaultDir;
  });

  const total = rows.length;
  const start = (query.page - 1) * query.limit;
  return {
    items: rows.slice(start, start + query.limit),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
    },
  };
}

// ─── Payments: shaping ──────────────────────────────────────────────────────────────────

async function paymentPayloads(
  docs: SubscriptionPaymentDoc[],
): Promise<SubscriptionPaymentPayload[]> {
  const [orgs, admins] = await Promise.all([
    Org.find({ _id: { $in: [...new Set(docs.map((d) => String(d.orgId)))] } })
      .select('name')
      .lean(),
    PlatformAdmin.find({ _id: { $in: [...new Set(docs.map((d) => String(d.recordedBy)))] } })
      .select('name')
      .lean(),
  ]);
  const orgName = new Map(orgs.map((o) => [String(o._id), o.name]));
  const adminName = new Map(admins.map((a) => [String(a._id), a.name]));
  return docs.map((d) => ({
    id: String(d._id),
    receiptNo: d.receiptNo,
    orgId: String(d.orgId),
    orgName: orgName.get(String(d.orgId)) ?? '—',
    amountMinor: d.amountMinor,
    method: d.method,
    trxId: d.trxId ?? null,
    months: d.months,
    planCode: d.planCode,
    periodStart: d.periodStart.toISOString(),
    periodEnd: d.periodEnd.toISOString(),
    paidAt: d.paidAt.toISOString(),
    note: d.note ?? null,
    recordedByName: adminName.get(String(d.recordedBy)) ?? null,
    createdAt: d.createdAt.toISOString(),
  }));
}

async function auditPayloads(orgId: Types.ObjectId): Promise<PlatformAuditPayload[]> {
  const rows = await PlatformAuditLog.find({ targetOrgId: orgId })
    .sort({ at: -1 })
    .limit(50)
    .lean();
  const admins = await PlatformAdmin.find({ _id: { $in: rows.map((r) => r.adminId) } })
    .select('name')
    .lean();
  const name = new Map(admins.map((a) => [String(a._id), a.name]));
  const org = await Org.findById(orgId).select('name').lean();
  return rows.map((r) => ({
    id: String(r._id),
    at: r.at.toISOString(),
    action: r.action,
    adminName: name.get(String(r.adminId)) ?? null,
    orgId: String(orgId),
    orgName: org?.name ?? null,
    details: r.details ?? null,
  }));
}

export async function getTenant(id: Types.ObjectId): Promise<TenantDetailPayload> {
  const org = await Org.findById(id).lean();
  if (!org) throw ApiError.notFound('Business');

  const [summary] = await summaries([org as OrgRow]);
  const state = subscriptionState(
    {
      status: org.status,
      trialEndsAt: org.trialEndsAt,
      currentPeriodEndsAt: org.currentPeriodEndsAt,
    },
    new Date(),
    config.saas.graceDays,
  );
  const payments = await SubscriptionPayment.find({ orgId: id }).sort({ paidAt: -1 }).lean();

  return {
    ...summary!,
    legalName: org.legalName ?? null,
    phone: org.phone ?? null,
    email: org.email ?? null,
    address: org.address ?? null,
    dueSince: iso(state.dueSince),
    graceEndsAt: iso(state.graceEndsAt),
    plan: await planByCode(org.planCode ?? null),
    payments: await paymentPayloads(payments),
    audit: await auditPayloads(id),
  };
}

async function assertPlanExists(code: string): Promise<void> {
  if (!(await Plan.exists({ code }))) {
    throw ApiError.validation('Validation failed', [
      { path: 'planCode', message: `No plan ${code}` },
    ]);
  }
}

/** A platform-made business: the owner's address is taken on trust, with a temporary password. */
export async function createTenant(
  actor: PlatformActor,
  input: CreateTenantInput,
): Promise<TenantDetailPayload> {
  await assertPlanExists(input.planCode);
  const created = await withTransaction(async (session) => {
    const result = await provisionOrg(
      {
        business: { name: input.businessName, phone: input.ownerPhone ?? null },
        owner: {
          name: input.ownerName,
          email: input.ownerEmail,
          phone: input.ownerPhone ?? null,
          password: input.password,
          mustChangePassword: true,
          emailVerified: true,
        },
        status: input.status,
        ...(input.status === 'TRIAL' ? { trialDays: input.trialDays } : {}),
        planCode: input.planCode,
        signupSource: 'PLATFORM',
      },
      session,
    );
    await writePlatformAudit(
      actor,
      'TENANT_CREATE',
      result.orgId,
      {
        name: input.businessName,
        ownerEmail: input.ownerEmail,
        planCode: input.planCode,
        status: input.status,
      },
      session,
    );
    return result;
  });
  return getTenant(created.orgId);
}

/** Load, change, audit and drop the cached access — the shape of every status action below. */
async function changeOrg(
  actor: PlatformActor,
  id: Types.ObjectId,
  action: Parameters<typeof writePlatformAudit>[1],
  decide: (org: OrgDoc) => { set: Partial<OrgDoc>; details?: Record<string, unknown> },
): Promise<TenantDetailPayload> {
  await withTransaction(async (session) => {
    const org = await Org.findById(id).session(session).lean();
    if (!org) throw ApiError.notFound('Business');
    const { set, details } = decide(org);
    await Org.updateOne({ _id: id }, { $set: set }, { session });
    const before = Object.fromEntries(
      Object.keys(set).map((k) => [k, org[k as keyof OrgDoc] ?? null]),
    );
    await writePlatformAudit(actor, action, id, { before, after: set, ...details }, session);
  });
  invalidateOrgAccess(id);
  return getTenant(id);
}

/** What the status returns to when a suspension or cancellation is lifted: the dates decide. */
function statusFromDates(org: OrgDoc): OrgStatus {
  if (org.currentPeriodEndsAt) return 'ACTIVE';
  if (org.trialEndsAt) return 'TRIAL';
  return 'ACTIVE';
}

export function suspendTenant(actor: PlatformActor, id: Types.ObjectId, input: ReasonInput) {
  return changeOrg(actor, id, 'TENANT_SUSPEND', (org) => {
    if (org.status === 'SUSPENDED')
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'Already suspended');
    if (org.status === 'CANCELLED')
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'This business is closed');
    return { set: { status: 'SUSPENDED' }, details: { reason: input.reason } };
  });
}

export function cancelTenant(actor: PlatformActor, id: Types.ObjectId, input: ReasonInput) {
  return changeOrg(actor, id, 'TENANT_CANCEL', (org) => {
    if (org.status === 'CANCELLED')
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'Already closed');
    return { set: { status: 'CANCELLED' }, details: { reason: input.reason } };
  });
}

export function reactivateTenant(actor: PlatformActor, id: Types.ObjectId, input: ReasonInput) {
  return changeOrg(actor, id, 'TENANT_REACTIVATE', (org) => {
    if (org.status !== 'SUSPENDED' && org.status !== 'CANCELLED') {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'Only a suspended or closed business can be reactivated',
      );
    }
    return { set: { status: statusFromDates(org) }, details: { reason: input.reason } };
  });
}

export async function changeTenantPlan(
  actor: PlatformActor,
  id: Types.ObjectId,
  input: ChangePlanInput,
) {
  await assertPlanExists(input.planCode);
  // Changing the plan answers any request the business made, whichever plan it asked for.
  return changeOrg(actor, id, 'TENANT_PLAN_CHANGE', () => ({
    set: { planCode: input.planCode, planRequest: null },
  }));
}

/** Turn a plan request down without changing anything else — the reason is kept in the history. */
export function dismissPlanRequest(actor: PlatformActor, id: Types.ObjectId, input: ReasonInput) {
  return changeOrg(actor, id, 'TENANT_PLAN_REQUEST_DISMISS', (org) => {
    if (!org.planRequest)
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'This business has no plan request');
    return {
      set: { planRequest: null },
      details: {
        reason: input.reason,
        requested: { planCode: org.planRequest.planCode, cycle: org.planRequest.cycle },
      },
    };
  });
}

export function extendTrial(actor: PlatformActor, id: Types.ObjectId, input: ExtendTrialInput) {
  return changeOrg(actor, id, 'TENANT_TRIAL_EXTEND', (org) => {
    if (org.currentPeriodEndsAt) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'This business has paid — record a payment instead',
      );
    }
    if (org.status === 'SUSPENDED' || org.status === 'CANCELLED') {
      throw ApiError.conflict('ILLEGAL_TRANSITION', 'Reactivate the business first');
    }
    const from = Math.max(Date.now(), org.trialEndsAt?.getTime() ?? 0);
    return {
      set: { status: 'TRIAL', trialEndsAt: new Date(from + input.days * DAY_MS) },
      details: { days: input.days },
    };
  });
}

// ─── Payments ───────────────────────────────────────────────────────────────────────────

/**
 * Record a payment: one transaction writes the payment with its receipt number, moves the business
 * to ACTIVE until the end of the period paid for, optionally on a new plan, and audits it.
 */
export async function recordPayment(
  actor: PlatformActor,
  id: Types.ObjectId,
  input: RecordPaymentInput,
): Promise<SubscriptionPaymentPayload> {
  const now = new Date();
  const paidAt = input.paidAt ?? now;
  if (paidAt.getTime() > now.getTime() + 60_000) {
    throw ApiError.validation('Validation failed', [
      { path: 'paidAt', message: 'Cannot be in the future' },
    ]);
  }
  if (input.planCode) await assertPlanExists(input.planCode);

  const paymentId = await withTransaction(async (session) => {
    const org = await Org.findById(id).session(session).lean();
    if (!org) throw ApiError.notFound('Business');
    if (org.status === 'SUSPENDED' || org.status === 'CANCELLED') {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'Reactivate the business before recording a payment',
      );
    }
    const planCode = input.planCode ?? org.planCode;
    if (!planCode) {
      throw ApiError.validation('Validation failed', [
        { path: 'planCode', message: 'This business has no plan yet — choose one' },
      ]);
    }

    const { start, end } = paymentPeriod(
      {
        status: org.status,
        trialEndsAt: org.trialEndsAt,
        currentPeriodEndsAt: org.currentPeriodEndsAt,
      },
      now,
      input.months,
    );
    const year = now.getUTCFullYear();
    const seq = await nextSequence(`platform:SUB:${year}`, session);
    const receiptNo = `SUB-${year}-${String(seq).padStart(5, '0')}`;

    const [payment] = await SubscriptionPayment.create(
      [
        {
          orgId: id,
          receiptNo,
          amountMinor: input.amountMinor,
          method: input.method,
          trxId: input.trxId ?? null,
          months: input.months,
          planCode,
          periodStart: start,
          periodEnd: end,
          paidAt,
          note: input.note ?? null,
          recordedBy: actor.admin._id,
        },
      ],
      { session },
    );

    await Org.updateOne(
      { _id: id },
      // A payment answers the business's plan request, if it had one.
      { $set: { status: 'ACTIVE', planCode, currentPeriodEndsAt: end, planRequest: null } },
      { session },
    );
    await writePlatformAudit(
      actor,
      'PAYMENT_RECORD',
      id,
      {
        receiptNo,
        amountMinor: input.amountMinor,
        method: input.method,
        months: input.months,
        planCode,
        periodEnd: end.toISOString(),
      },
      session,
    );
    return payment!._id;
  });

  invalidateOrgAccess(id);
  return getPayment(paymentId);
}

export async function getPayment(id: Types.ObjectId): Promise<SubscriptionPaymentPayload> {
  const doc = await SubscriptionPayment.findById(id).lean();
  if (!doc) throw ApiError.notFound('Payment');
  const [payload] = await paymentPayloads([doc]);
  return payload!;
}

export async function listPayments(
  query: ListPaymentsQuery,
): Promise<{ items: SubscriptionPaymentPayload[]; meta: PageMeta }> {
  const filter: Record<string, unknown> = {};
  if (query.orgId) filter.orgId = new Types.ObjectId(query.orgId);
  if (query.q)
    filter.$or = [{ receiptNo: new RegExp(escapeRegex(query.q), 'i') }, { trxId: query.q }];

  const [docs, total] = await Promise.all([
    SubscriptionPayment.find(filter)
      .sort({ paidAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    SubscriptionPayment.countDocuments(filter),
  ]);
  return {
    items: await paymentPayloads(docs),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
    },
  };
}

// ─── Dashboard ──────────────────────────────────────────────────────────────────────────

export async function platformDashboard(): Promise<PlatformDashboardPayload> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const yearAgo = new Date(
    Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()),
  );

  const orgs = await Org.find().select(SUMMARY_FIELDS).lean<OrgRow[]>();
  const rows = await summaries(orgs, now);

  const tenants: PlatformDashboardPayload['tenants'] = {
    total: rows.length,
    TRIAL: 0,
    ACTIVE: 0,
    PAST_DUE: 0,
    SUSPENDED: 0,
    CANCELLED: 0,
  };
  for (const r of rows) tenants[r.status] += 1;

  const sum = async (from: Date, to: Date) =>
    (
      await SubscriptionPayment.aggregate<{ total: number }>([
        { $match: { paidAt: { $gte: from, $lt: to } } },
        { $group: { _id: null, total: { $sum: '$amountMinor' } } },
      ])
    )[0]?.total ?? 0;

  const [thisMonthMinor, lastMonthMinor, last12MonthsMinor, recent] = await Promise.all([
    sum(monthStart, new Date(now.getTime() + 1)),
    sum(lastMonthStart, monthStart),
    sum(yearAgo, new Date(now.getTime() + 1)),
    SubscriptionPayment.find().sort({ paidAt: -1 }).limit(8).lean(),
  ]);

  return {
    tenants,
    readOnly: rows.filter((r) => r.access === 'READ_ONLY').length,
    revenue: { thisMonthMinor, lastMonthMinor, last12MonthsMinor },
    signupsThisMonth: rows.filter((r) => r.createdAt >= monthStart.toISOString()).length,
    trialsEndingSoon: rows
      .filter((r) => r.status === 'TRIAL' && r.daysLeft !== null && r.daysLeft <= 7)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
    overdue: rows
      .filter((r) => r.status === 'PAST_DUE')
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
    planRequests: rows
      .filter((r) => r.planRequest)
      .sort((a, b) => (a.planRequest!.requestedAt < b.planRequest!.requestedAt ? -1 : 1)),
    recentPayments: await paymentPayloads(recent),
  };
}
