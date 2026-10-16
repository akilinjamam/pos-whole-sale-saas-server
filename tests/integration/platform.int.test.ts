import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { addMonths } from '../../src/domain/subscription.js';
import { login } from '../../src/modules/auth/auth.service.js';
import { Org } from '../../src/modules/org/org.model.js';
import { DEFAULT_PLANS, Plan } from '../../src/modules/plan/plan.model.js';
import { PlatformAdmin } from '../../src/modules/platform/platformAdmin.model.js';
import { PlatformAuditLog } from '../../src/modules/platform/platformAuditLog.model.js';
import { invalidatePlans } from '../../src/services/subscription.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * SaaS phase 5's "done when", over real HTTP: a platform admin creates a business, records its
 * bKash payment and sees the period move, suspends it — and the business feels each change on its
 * next request. Plus the walls: platform and tenant tokens never stand in for each other, and an
 * admin without `platform:billing` cannot record money.
 */

const run = randomUUID().slice(0, 8);
const PASSWORD = 'Platform123!';
const ZZ_PLAN = `ZZ${run.slice(0, 6).toUpperCase()}`;

let server: Server;
let base: string;
let rootToken: string;
let limitedToken: string;
const adminIds: Types.ObjectId[] = [];
const orgIds: Types.ObjectId[] = [];

type Json = {
  data?: Record<string, unknown> & { id?: string };
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
};

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Json | null };
}

async function makeAdmin(email: string, permissions: string[]) {
  const admin = await new PlatformAdmin({
    name: `ZZTEST ${email}`,
    email,
    passwordHash: PASSWORD,
    permissions,
  }).save();
  adminIds.push(admin._id);
}

async function platformLogin(email: string): Promise<string> {
  const res = await call(null, 'POST', 'platform/auth/login', { email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return String(res.json!.data!.accessToken);
}

beforeAll(async () => {
  await connectDatabase();
  for (const plan of DEFAULT_PLANS) {
    await Plan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
  }
  invalidatePlans();

  await makeAdmin(`zztest-root-${run}@example.invalid`, [
    'platform:tenants',
    'platform:billing',
    'platform:plans',
    'platform:admins',
  ]);
  await makeAdmin(`zztest-limited-${run}@example.invalid`, ['platform:tenants']);

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  rootToken = await platformLogin(`zztest-root-${run}@example.invalid`);
  limitedToken = await platformLogin(`zztest-limited-${run}@example.invalid`);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  for (const id of orgIds) await cleanupOrg(id);
  await PlatformAuditLog.deleteMany({ adminId: { $in: adminIds } });
  await PlatformAdmin.deleteMany({ _id: { $in: adminIds } });
  await Plan.deleteMany({ code: ZZ_PLAN });
  invalidatePlans();
  await disconnectDatabase();
});

describe('a business, from creation to suspension', () => {
  const ownerEmail = `zztest-plat-owner-${run}@example.invalid`;
  let orgId = '';
  let ownerToken = '';
  let trialEndsAt = '';

  it('is created by the platform on a trial, with a temporary password', async () => {
    const res = await call(rootToken, 'POST', 'platform/tenants', {
      businessName: `ZZTEST Platform Optical ${run}`,
      ownerName: 'Platform Owner',
      ownerEmail,
      password: PASSWORD,
      planCode: 'STARTER',
      status: 'TRIAL',
      trialDays: 14,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    orgId = String(res.json!.data!.id);
    orgIds.push(new Types.ObjectId(orgId));
    trialEndsAt = String(res.json!.data!.trialEndsAt);
    expect(res.json!.data).toMatchObject({ status: 'TRIAL', planCode: 'STARTER', ownerEmail });

    const owner = await login({ email: ownerEmail, password: PASSWORD });
    expect(owner.user.mustChangePassword).toBe(true);
    expect(owner.user.emailVerified).toBe(true);
    ownerToken = owner.accessToken;
  });

  it('appears in the list, searchable by owner email', async () => {
    const res = await call(rootToken, 'GET', `platform/tenants?q=${encodeURIComponent(ownerEmail)}`);
    expect(res.status).toBe(200);
    const items = res.json!.data as unknown as { id: string }[];
    expect(items.map((t) => t.id)).toEqual([orgId]);
  });

  it('records a bKash payment: ACTIVE, and the unused trial days are kept', async () => {
    const res = await call(rootToken, 'POST', `platform/tenants/${orgId}/payments`, {
      amountMinor: 150_000,
      method: 'BKASH',
      trxId: `ZZTRX${run}`,
      months: 1,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const payment = res.json!.data!;
    expect(String(payment.receiptNo)).toMatch(/^SUB-\d{4}-\d{5}$/);
    expect(payment.periodStart).toBe(trialEndsAt);
    expect(payment.periodEnd).toBe(addMonths(new Date(trialEndsAt), 1).toISOString());

    const org = await Org.findById(orgId).lean();
    expect(org?.status).toBe('ACTIVE');
    expect(org?.currentPeriodEndsAt?.toISOString()).toBe(payment.periodEnd);

    // The business sees it at once.
    const sub = await call(ownerToken, 'GET', 'org/subscription');
    expect(sub.json!.data).toMatchObject({ status: 'ACTIVE', planCode: 'STARTER' });
  });

  it('refuses the same bKash transaction twice', async () => {
    const res = await call(rootToken, 'POST', `platform/tenants/${orgId}/payments`, {
      amountMinor: 150_000,
      method: 'BKASH',
      trxId: `ZZTRX${run}`,
      months: 1,
    });
    expect(res.status).toBe(409);
  });

  it('will not extend the trial of a business that has paid', async () => {
    const res = await call(rootToken, 'POST', `platform/tenants/${orgId}/extend-trial`, { days: 7 });
    expect(res.status).toBe(409);
  });

  it('changes plan, and the business gets the new features on its next request', async () => {
    expect((await call(ownerToken, 'GET', 'reports/sales')).json?.error?.code).toBe('FEATURE_NOT_IN_PLAN');
    const res = await call(rootToken, 'POST', `platform/tenants/${orgId}/plan`, { planCode: 'BUSINESS' });
    expect(res.status).toBe(200);
    expect((await call(ownerToken, 'GET', 'reports/sales')).json?.error?.code).not.toBe(
      'FEATURE_NOT_IN_PLAN',
    );
  });

  it('suspends — the business is shut out on its very next request — and reactivates', async () => {
    expect((await call(ownerToken, 'GET', 'orders')).status).toBe(200);

    const suspended = await call(rootToken, 'POST', `platform/tenants/${orgId}/suspend`, {
      reason: 'ZZTEST unpaid',
    });
    expect(suspended.json!.data).toMatchObject({ status: 'SUSPENDED', access: 'BLOCKED' });
    expect((await call(ownerToken, 'GET', 'orders')).json?.error?.code).toBe('ORG_SUSPENDED');

    const back = await call(rootToken, 'POST', `platform/tenants/${orgId}/reactivate`, {
      reason: 'ZZTEST paid',
    });
    expect(back.json!.data).toMatchObject({ status: 'ACTIVE', access: 'FULL' });
    expect((await call(ownerToken, 'GET', 'orders')).status).toBe(200);
  });

  it('keeps the payments and an audit trail on the business', async () => {
    const res = await call(rootToken, 'GET', `platform/tenants/${orgId}`);
    const detail = res.json!.data as unknown as {
      payments: unknown[];
      audit: { action: string; adminName: string }[];
    };
    expect(detail.payments).toHaveLength(1);
    expect(detail.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['TENANT_CREATE', 'PAYMENT_RECORD', 'TENANT_PLAN_CHANGE', 'TENANT_SUSPEND', 'TENANT_REACTIVATE']),
    );

    const list = await call(rootToken, 'GET', `platform/payments?orgId=${orgId}`);
    expect(list.json!.meta).toMatchObject({ total: 1 });
  });

  it('counts the business on the dashboard', async () => {
    const res = await call(rootToken, 'GET', 'platform/dashboard');
    expect(res.status).toBe(200);
    expect((res.json!.data as { tenants: { total: number } }).tenants.total).toBeGreaterThan(0);
  });
});

describe('the walls', () => {
  it('a tenant token is refused by every platform route, and a platform token by tenant routes', async () => {
    const tenantOwner = await call(rootToken, 'POST', 'platform/tenants', {
      businessName: `ZZTEST Wall ${run}`,
      ownerName: 'Wall Owner',
      ownerEmail: `zztest-wall-${run}@example.invalid`,
      password: PASSWORD,
      planCode: 'BUSINESS',
      status: 'ACTIVE',
    });
    orgIds.push(new Types.ObjectId(String(tenantOwner.json!.data!.id)));
    const tenantToken = (await login({ email: `zztest-wall-${run}@example.invalid`, password: PASSWORD }))
      .accessToken;

    for (const path of ['platform/auth/me', 'platform/tenants', 'platform/dashboard', 'platform/admins']) {
      expect((await call(tenantToken, 'GET', path)).status, path).toBe(401);
    }
    expect((await call(rootToken, 'GET', 'orders')).status).toBe(401);
    expect((await call(rootToken, 'GET', 'auth/me')).status).toBe(401);
  });

  it('an admin without platform:billing cannot record a payment, or touch plans and admins', async () => {
    const [orgId] = orgIds;
    expect((await call(limitedToken, 'GET', 'platform/dashboard')).status).toBe(200);
    const pay = await call(limitedToken, 'POST', `platform/tenants/${String(orgId)}/payments`, {
      amountMinor: 1_000,
      method: 'CASH',
      months: 1,
    });
    expect(pay.status).toBe(403);
    expect((await call(limitedToken, 'GET', 'platform/admins')).status).toBe(403);
    expect((await call(limitedToken, 'POST', 'platform/plans', {})).status).toBe(403);
  });

  it('an admin cannot lock themselves out', async () => {
    const me = await call(rootToken, 'GET', 'platform/auth/me');
    const id = String(me.json!.data!.id);
    expect((await call(rootToken, 'PATCH', `platform/admins/${id}`, { isActive: false })).status).toBe(409);
    expect(
      (await call(rootToken, 'PATCH', `platform/admins/${id}`, { permissions: ['platform:tenants'] })).status,
    ).toBe(409);
  });
});

describe('plans', () => {
  it('can be created and edited, and edits apply at once', async () => {
    const created = await call(rootToken, 'POST', 'platform/plans', {
      code: ZZ_PLAN,
      name: 'ZZTEST plan',
      priceMonthlyMinor: 100_000,
      priceYearlyMinor: 1_000_000,
      limits: { users: 2, locations: 2, products: 10 },
      features: [],
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const edited = await call(rootToken, 'PATCH', `platform/plans/${ZZ_PLAN}`, {
      limits: { users: 5, locations: 2, products: 10 },
      features: ['POS'],
    });
    expect(edited.json!.data).toMatchObject({ limits: { users: 5 }, features: ['POS'] });
  });
});

describe('platform sign-out', () => {
  it('ends the session everywhere', async () => {
    expect((await call(limitedToken, 'POST', 'platform/auth/logout')).status).toBe(204);
    expect((await call(limitedToken, 'GET', 'platform/auth/me')).status).toBe(401);
  });
});
