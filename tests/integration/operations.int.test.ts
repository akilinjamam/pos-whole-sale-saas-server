import { randomUUID } from 'node:crypto';

import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { login } from '../../src/modules/auth/auth.service.js';
import { Org } from '../../src/modules/org/org.model.js';
import { Brand } from '../../src/modules/brand/brand.model.js';
import { User } from '../../src/modules/user/user.model.js';
import { outbox } from '../../src/services/mailer.service.js';
import { purgeOrg } from '../../src/services/orgPurge.service.js';
import { provisionOrg } from '../../src/services/provisioning.service.js';
import { invalidateOrgAccess } from '../../src/services/subscription.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { ProvisionedOrg } from '../../src/services/provisioning.service.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * SaaS phase 7 over real HTTP: a business downloads all its data — and only its own — whatever its
 * subscription; the owner closes it; the purge deletes it after the keeping period, and only it.
 */

const run = randomUUID().slice(0, 8);
const PASSWORD = 'Ops12345!';
const DAY = 86_400_000;

let mine: ProvisionedOrg;
let other: ProvisionedOrg;
let server: Server;
let base: string;
let ownerToken: string;
let repToken: string;
const ownerEmail = `zztest-ops-${run}@example.invalid`;
const businessName = `ZZTEST Ops ${run}`;

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res;
}
const json = async (res: Response) =>
  (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };

async function download(token: string) {
  const res = await call(token, 'GET', 'org/export');
  if (res.status !== 200) return { status: res.status, files: {} as Record<string, string> };
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)])),
  };
}

const provision = (name: string, email: string) =>
  withTransaction((session) =>
    provisionOrg(
      {
        business: { name },
        owner: { name: 'Ops Owner', email, password: PASSWORD, emailVerified: true },
        status: 'ACTIVE',
        planCode: null,
        signupSource: 'PLATFORM',
      },
      session,
    ),
  );

beforeAll(async () => {
  await connectDatabase();
  mine = await provision(businessName, ownerEmail);
  other = await provision(`ZZTEST Ops Other ${run}`, `zztest-ops-other-${run}@example.invalid`);
  ownerToken = (await login({ email: ownerEmail, password: PASSWORD })).accessToken;

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  expect((await call(ownerToken, 'POST', 'brands', { name: `ZZ Mine ${run}` })).status).toBe(201);
  await Brand.create({ orgId: other.orgId, name: `ZZ Theirs ${run}`, slug: `zz-theirs-${run}` });

  const rep = await call(ownerToken, 'POST', 'users', {
    name: 'Rep',
    email: `zztest-ops-rep-${run}@example.invalid`,
    password: PASSWORD,
    roleIds: [String(mine.roleIds.get('SALES_REP'))],
  });
  expect(rep.status).toBe(201);
  repToken = (await login({ email: `zztest-ops-rep-${run}@example.invalid`, password: PASSWORD }))
    .accessToken;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (mine) await cleanupOrg(mine.orgId);
  if (other) await cleanupOrg(other.orgId);
  await disconnectDatabase();
});

describe('data export', () => {
  it('is a zip of the business’s own records, with no secrets', async () => {
    const zip = await download(ownerToken);
    expect(zip.status).toBe(200);
    expect(zip.type).toBe('application/zip');
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['README.txt', 'business.json', 'json/brands.json', 'csv/brands.csv']),
    );
    expect(JSON.parse(zip.files['business.json']!).name).toBe(businessName);

    const brands = JSON.parse(zip.files['json/brands.json']!) as { name: string; orgId: string }[];
    expect(brands.map((b) => b.name)).toContain(`ZZ Mine ${run}`);
    expect(brands.every((b) => b.orgId === String(mine.orgId))).toBe(true);
    expect(zip.files['csv/brands.csv']).toContain(`ZZ Mine ${run}`);

    const everything = Object.values(zip.files).join('\n');
    expect(everything).not.toContain(`ZZ Theirs ${run}`);
    expect(everything).not.toContain(String(other.orgId));
    expect(everything).not.toContain('passwordHash');
    expect(Object.keys(zip.files).some((f) => f.includes('email_tokens'))).toBe(false);
  });

  it('needs org:export — a sales rep is refused', async () => {
    expect((await call(repToken, 'GET', 'org/export')).status).toBe(403);
  });

  it('stays open while read-only', async () => {
    await Org.updateOne(
      { _id: mine.orgId },
      { $set: { status: 'TRIAL', trialEndsAt: new Date(Date.now() - 60 * DAY) } },
    );
    invalidateOrgAccess(mine.orgId);
    expect((await call(ownerToken, 'POST', 'brands', { name: 'ZZ nope' })).status).toBe(402);
    expect((await download(ownerToken)).status).toBe(200);
    await Org.updateOne(
      { _id: mine.orgId },
      { $set: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEndsAt: null } },
    );
    invalidateOrgAccess(mine.orgId);
  });
});

describe('closing the business', () => {
  it('refuses anyone but the owner', async () => {
    const res = await call(repToken, 'POST', 'org/close', {
      businessName,
      password: PASSWORD,
    });
    expect(res.status).toBe(403);
  });

  it('wants the name typed out and the right password', async () => {
    const res = await call(ownerToken, 'POST', 'org/close', {
      businessName: 'something else',
      password: 'wrong-password',
    });
    expect(res.status).toBe(422);
    const paths = ((await json(res)).error?.details as { path: string }[]).map((d) => d.path);
    expect(paths.sort()).toEqual(['businessName', 'password']);
  });

  it('closes it: everyone is shut out, the data stays downloadable, a purge date is set', async () => {
    const res = await call(ownerToken, 'POST', 'org/close', {
      businessName: businessName.toLowerCase(),
      password: PASSWORD,
      reason: 'ZZTEST moving on',
    });
    expect(res.status).toBe(200);
    const sub = (await json(res)).data!;
    expect(sub.status).toBe('CANCELLED');
    const purgeAfter = new Date(String(sub.purgeAfter)).getTime();
    expect(purgeAfter - Date.now()).toBeGreaterThan(80 * DAY);

    expect((await json(await call(ownerToken, 'GET', 'orders'))).error?.code).toBe(
      'ORG_SUSPENDED',
    );
    expect((await download(ownerToken)).status).toBe(200);
    expect(outbox.some((m) => m.to === ownerEmail && m.subject.endsWith('has been closed'))).toBe(
      true,
    );
  });
});

describe('purging', () => {
  it('refuses before the keeping period is over', async () => {
    await expect(purgeOrg(mine.orgId, { execute: false })).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    await expect(purgeOrg(other.orgId, { execute: true })).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('a dry run counts and deletes nothing; --execute deletes this business only', async () => {
    await Org.updateOne({ _id: mine.orgId }, { $set: { purgeAfter: new Date(Date.now() - DAY) } });

    const dry = await purgeOrg(mine.orgId, { execute: false });
    expect(dry.executed).toBe(false);
    expect(dry.collections.users).toBe(2);
    expect(dry.collections.brands).toBeGreaterThanOrEqual(1);
    expect(await User.countDocuments({ orgId: mine.orgId })).toBe(2);

    const done = await purgeOrg(mine.orgId, { execute: true });
    expect(done.total).toBe(dry.total);
    expect(await User.countDocuments({ orgId: mine.orgId })).toBe(0);
    expect(await Brand.countDocuments({ orgId: mine.orgId })).toBe(0);

    // The tombstone: name kept, contact cleared, purgedAt set.
    const org = await Org.findById(mine.orgId).lean();
    expect(org).toMatchObject({ name: businessName, phone: null, status: 'CANCELLED' });
    expect(org?.purgedAt).toBeInstanceOf(Date);

    // Somebody else's business is untouched, and running it again finds nothing left.
    expect(await Brand.countDocuments({ orgId: other.orgId })).toBe(1);
    expect(await User.countDocuments({ orgId: other.orgId })).toBe(1);
    expect((await purgeOrg(mine.orgId, { execute: true })).total).toBe(0);
  });
});
