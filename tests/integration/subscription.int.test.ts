import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { login } from '../../src/modules/auth/auth.service.js';
import { Org } from '../../src/modules/org/org.model.js';
import { DEFAULT_PLANS, Plan } from '../../src/modules/plan/plan.model.js';
import { provisionOrg } from '../../src/services/provisioning.service.js';
import { invalidateOrgAccess, invalidatePlans } from '../../src/services/subscription.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { ProvisionedOrg } from '../../src/services/provisioning.service.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * SaaS phase 4's "done when", over real HTTP: a business on the Starter plan meets its user limit
 * and its plan's missing features; an ended trial is past due, then read-only after the grace
 * period; a suspended business is shut out but can still see why.
 */

const run = randomUUID().slice(0, 8);
const PASSWORD = 'Plan1234!';
const DAY = 86_400_000;

let org: ProvisionedOrg;
let server: Server;
let base: string;
let token: string;
let userLimit: number;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown>;
    error?: { code: string; details?: Record<string, unknown> };
  } | null;
  return { status: res.status, json };
}

/** Rewrite the business's subscription in the database, and drop the cached copy. */
async function setSubscription(fields: Record<string, unknown>) {
  await Org.updateOne({ _id: org.orgId }, { $set: fields });
  invalidateOrgAccess(org.orgId);
}

beforeAll(async () => {
  await connectDatabase();
  // The plans exist in any seeded database; insert them here only if this one is not.
  for (const plan of DEFAULT_PLANS) {
    await Plan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
  }
  invalidatePlans();
  userLimit = (await Plan.findOne({ code: 'STARTER' }).lean())!.limits.users!;

  org = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: `ZZTEST Starter ${run}` },
        owner: {
          name: 'Starter Owner',
          email: `zztest-starter-${run}@example.invalid`,
          password: PASSWORD,
          emailVerified: true,
        },
        status: 'ACTIVE',
        planCode: 'STARTER',
        signupSource: 'PLATFORM',
      },
      session,
    ),
  );
  token = (await login({ email: `zztest-starter-${run}@example.invalid`, password: PASSWORD }))
    .accessToken;

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (org) await cleanupOrg(org.orgId);
  await disconnectDatabase();
});

describe('the plan', () => {
  it('is reported with usage', async () => {
    const { status, json } = await call('GET', 'org/subscription');
    expect(status).toBe(200);
    expect(json?.data).toMatchObject({
      status: 'ACTIVE',
      access: 'FULL',
      planCode: 'STARTER',
      usage: { users: 1, locations: 2 },
    });
  });

  it('leaves out what Starter does not include, and keeps the core', async () => {
    const pos = await call('GET', 'pos/sessions');
    expect(pos.status).toBe(403);
    expect(pos.json?.error?.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await call('GET', 'reports/sales')).json?.error?.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await call('GET', 'purchase-orders')).json?.error?.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await call('GET', 'orders')).status).toBe(200);
  });

  it('refuses a user past the limit, and makes room when one is deactivated', async () => {
    const user = (n: number) => ({
      name: `Staff ${n}`,
      email: `zztest-starter-${run}-${n}@example.invalid`,
      password: PASSWORD,
      roleIds: [String(org.roleIds.get('SALES_REP'))],
    });

    const ids: string[] = [];
    for (let n = 2; n <= userLimit; n += 1) {
      const res = await call('POST', 'users', user(n));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      ids.push(String(res.json!.data!.id));
    }

    const over = await call('POST', 'users', user(99));
    expect(over.status).toBe(409);
    expect(over.json?.error?.code).toBe('PLAN_LIMIT_REACHED');
    expect(over.json?.error?.details).toMatchObject({ resource: 'users', limit: userLimit, used: userLimit });

    expect((await call('DELETE', `users/${ids[0]}`)).status).toBeLessThan(300);
    expect((await call('POST', 'users', user(99))).status).toBe(201);

    // …and switching the deactivated one back on would now exceed it again.
    const back = await call('PATCH', `users/${ids[0]}`, { isActive: true });
    expect(back.json?.error?.code).toBe('PLAN_LIMIT_REACHED');
  });
});

describe('when the trial ends', () => {
  it('is past due at once, with full access during the grace period', async () => {
    await setSubscription({ status: 'TRIAL', trialEndsAt: new Date(Date.now() - 2 * DAY) });

    const sub = await call('GET', 'org/subscription');
    expect(sub.json?.data).toMatchObject({ status: 'PAST_DUE', access: 'FULL' });
    expect(sub.json?.data?.daysLeft).toBeGreaterThan(0);

    expect((await call('POST', 'brands', { name: `ZZ Grace ${run}` })).status).toBe(201);
  });

  it('becomes read-only after the grace period: reads work, changes are refused with 402', async () => {
    await setSubscription({ status: 'TRIAL', trialEndsAt: new Date(Date.now() - 30 * DAY) });

    const write = await call('POST', 'brands', { name: `ZZ ReadOnly ${run}` });
    expect(write.status).toBe(402);
    expect(write.json?.error?.code).toBe('SUBSCRIPTION_EXPIRED');

    expect((await call('GET', 'orders')).status).toBe(200);
    expect((await call('GET', 'brands')).status).toBe(200);
    expect((await call('GET', 'org/subscription')).json?.data).toMatchObject({
      status: 'PAST_DUE',
      access: 'READ_ONLY',
    });
    // The caller's own session still works — resending a verification email is a POST.
    expect((await call('POST', 'auth/resend-verification')).status).toBe(200);
  });

  it('a renewal restores everything', async () => {
    await setSubscription({
      status: 'ACTIVE',
      currentPeriodEndsAt: new Date(Date.now() + 30 * DAY),
    });
    expect((await call('POST', 'brands', { name: `ZZ Renewed ${run}` })).status).toBe(201);
  });
});

describe('a plan request', () => {
  it('lists the plans on offer', async () => {
    const plans = (await call('GET', 'org/subscription')).json?.data?.plans as { code: string }[];
    expect(plans.map((p) => p.code)).toEqual(expect.arrayContaining(['STARTER', 'BUSINESS']));
  });

  it('is accepted even when read-only, replaced when asked again, and withdrawn', async () => {
    await setSubscription({ status: 'TRIAL', trialEndsAt: new Date(Date.now() - 30 * DAY) });

    const first = await call('POST', 'org/subscription/plan-request', {
      planCode: 'business',
      cycle: 'YEARLY',
      note: 'Paying by bKash',
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json?.data?.planRequest).toMatchObject({
      planCode: 'BUSINESS',
      planName: 'Business',
      cycle: 'YEARLY',
      note: 'Paying by bKash',
      requestedByName: 'Starter Owner',
    });
    // Nothing changes until the platform acts.
    expect(first.json?.data?.planCode).toBe('STARTER');

    const second = await call('POST', 'org/subscription/plan-request', {
      planCode: 'STARTER',
      cycle: 'MONTHLY',
    });
    expect(second.json?.data?.planRequest).toMatchObject({ planCode: 'STARTER', note: null });

    const gone = await call('DELETE', 'org/subscription/plan-request');
    expect(gone.status).toBe(200);
    expect(gone.json?.data?.planRequest).toBeNull();

    await setSubscription({
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodEndsAt: new Date(Date.now() + 30 * DAY),
    });
  });

  it('refuses a plan that does not exist', async () => {
    const res = await call('POST', 'org/subscription/plan-request', {
      planCode: 'NOPE',
      cycle: 'MONTHLY',
    });
    expect(res.status).toBe(422);
  });
});

describe('a suspended business', () => {
  it('is shut out, but can still sign in and read why', async () => {
    await setSubscription({ status: 'SUSPENDED' });

    const blocked = await call('GET', 'orders');
    expect(blocked.status).toBe(403);
    expect(blocked.json?.error?.code).toBe('ORG_SUSPENDED');

    expect((await call('GET', 'auth/me')).status).toBe(200);
    expect((await call('GET', 'org/subscription')).json?.data).toMatchObject({
      status: 'SUSPENDED',
      access: 'BLOCKED',
    });
    await expect(
      login({ email: `zztest-starter-${run}@example.invalid`, password: PASSWORD }),
    ).resolves.toBeTruthy();
  });
});
