import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { login } from '../../src/modules/auth/auth.service.js';
import { PlatformAdmin } from '../../src/modules/platform/platformAdmin.model.js';
import { PlatformAuditLog } from '../../src/modules/platform/platformAuditLog.model.js';
import { Tutorial, publishedTutorials } from '../../src/modules/tutorial/tutorial.model.js';
import { provisionOrg } from '../../src/services/provisioning.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { ProvisionedOrg } from '../../src/services/provisioning.service.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Types } from 'mongoose';

/**
 * Training videos over real HTTP: a platform admin with `platform:content` manages them (and one
 * without cannot), every business reads the published ones, and the landing page gets the overview
 * video as its demo. Runs against the shared database, so it only ever looks at its own ZZTEST rows.
 */

const run = randomUUID().slice(0, 8);
const PASSWORD = 'Tutorial123!';
const LINK = 'https://youtu.be/dQw4w9WgXcQ?si=zz';

let server: Server;
let base: string;
let contentToken: string;
let otherToken: string;
let userToken: string;
let org: ProvisionedOrg;
const adminIds: Types.ObjectId[] = [];

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown> & { id?: string };
    error?: { code: string; details?: { path: string }[] };
  } | null;
  return { status: res.status, json };
}

async function admin(email: string, permissions: string[]): Promise<string> {
  const doc = await new PlatformAdmin({ name: `ZZTEST ${email}`, email, passwordHash: PASSWORD, permissions }).save();
  adminIds.push(doc._id);
  const res = await call(null, 'POST', 'platform/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return String(res.json!.data!.accessToken);
}

beforeAll(async () => {
  await connectDatabase();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  contentToken = await admin(`zztest-content-${run}@example.invalid`, ['platform:content']);
  otherToken = await admin(`zztest-nocontent-${run}@example.invalid`, ['platform:tenants']);

  const email = `zztest-tut-${run}@example.invalid`;
  org = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: `ZZTEST Tutorials ${run}` },
        owner: { name: 'Tut Owner', email, password: PASSWORD, emailVerified: true },
        status: 'ACTIVE',
        planCode: null,
        signupSource: 'PLATFORM',
      },
      session,
    ),
  );
  userToken = (await login({ email, password: PASSWORD })).accessToken;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await Tutorial.deleteMany({ titleEn: { $regex: `^ZZTEST ${run}` } });
  await PlatformAuditLog.deleteMany({ adminId: { $in: adminIds } });
  await PlatformAdmin.deleteMany({ _id: { $in: adminIds } });
  if (org) await cleanupOrg(org.orgId);
  await disconnectDatabase();
});

describe('tutorials', () => {
  let id = '';

  it('a content admin adds one from a pasted link — the id is kept, not the link', async () => {
    const res = await call(contentToken, 'POST', 'platform/tutorials', {
      topic: 'sales',
      titleBn: 'অর্ডার নেওয়া',
      titleEn: `ZZTEST ${run} taking an order`,
      youtubeId: LINK,
      isPublished: false,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json!.data).toMatchObject({ youtubeId: 'dQw4w9WgXcQ', topic: 'sales', isPublished: false });
    id = String(res.json!.data!.id);
    expect(await PlatformAuditLog.exists({ action: 'TUTORIAL_CREATE', adminId: { $in: adminIds } })).toBeTruthy();
  });

  it('refuses a link that is not YouTube, and an unknown topic', async () => {
    const res = await call(contentToken, 'POST', 'platform/tutorials', {
      topic: 'nowhere',
      titleBn: 'x',
      titleEn: `ZZTEST ${run} bad`,
      youtubeId: 'https://vimeo.com/123',
    });
    expect(res.status).toBe(422);
    const paths = (res.json!.error!.details ?? []).map((d) => d.path).sort();
    expect(paths).toEqual(['topic', 'youtubeId']);
  });

  it('an admin without platform:content cannot touch them', async () => {
    expect((await call(otherToken, 'GET', 'platform/tutorials')).status).toBe(403);
    expect((await call(otherToken, 'PATCH', `platform/tutorials/${id}`, { isPublished: true })).status).toBe(403);
  });

  it('a business sees only published videos — once published, it is there', async () => {
    const before = await call(userToken, 'GET', 'tutorials');
    expect(before.status).toBe(200);
    expect((before.json!.data as unknown as { id: string }[]).some((t) => t.id === id)).toBe(false);

    expect((await call(contentToken, 'PATCH', `platform/tutorials/${id}`, { isPublished: true })).status).toBe(200);
    const after = await call(userToken, 'GET', 'tutorials');
    expect((after.json!.data as unknown as { id: string }[]).some((t) => t.id === id)).toBe(true);
  });

  it('the landing page gets the first published overview video as its demo', async () => {
    await call(contentToken, 'POST', 'platform/tutorials', {
      topic: 'overview',
      titleBn: 'দুই মিনিটে দেখুন',
      titleEn: `ZZTEST ${run} demo`,
      youtubeId: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    });
    const site = await call(null, 'GET', 'public/site');
    const expected = (await publishedTutorials('overview'))[0]!;
    expect(site.json!.data!.demoVideo).toEqual({
      youtubeId: expected.youtubeId,
      titleBn: expected.titleBn,
      titleEn: expected.titleEn,
    });
  });

  it('deletes, audited', async () => {
    expect((await call(contentToken, 'DELETE', `platform/tutorials/${id}`)).status).toBe(204);
    expect(await Tutorial.exists({ _id: id })).toBeNull();
    expect(await PlatformAuditLog.exists({ action: 'TUTORIAL_DELETE', adminId: { $in: adminIds } })).toBeTruthy();
    expect((await call(contentToken, 'DELETE', `platform/tutorials/${id}`)).status).toBe(404);
  });
});
