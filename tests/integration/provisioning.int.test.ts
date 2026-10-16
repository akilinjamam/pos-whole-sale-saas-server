import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { login, myLocations } from '../../src/modules/auth/auth.service.js';
import { Org } from '../../src/modules/org/org.model.js';
import { PriceTier } from '../../src/modules/priceTier/priceTier.model.js';
import { Role } from '../../src/modules/role/role.model.js';
import { getRole } from '../../src/modules/role/role.service.js';
import { createUser, updateUser } from '../../src/modules/user/user.service.js';
import { provisionOrg } from '../../src/services/provisioning.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { ProvisionedOrg } from '../../src/services/provisioning.service.js';

/**
 * SaaS phase 1's "done when": two businesses provisioned side by side each log in to their own,
 * complete, empty system — and an email identifies exactly one user on the whole platform.
 */

const run = new Types.ObjectId().toHexString().slice(-8);
const PASSWORD = 'Test1234!';
const emailA = `zztest-owner-a-${run}@example.invalid`;
const emailB = `zztest-owner-b-${run}@example.invalid`;
// The same business name twice, to prove the slugs still differ.
const NAME = `ZZTEST Optical ${run}`;

let a: ProvisionedOrg;
let b: ProvisionedOrg;
const now = new Date('2026-10-16T06:00:00.000Z');

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeAll(async () => {
  await connectDatabase();
  a = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: NAME },
        owner: { name: 'Owner A', email: emailA, password: PASSWORD },
        status: 'TRIAL',
        trialDays: 14,
        signupSource: 'SIGNUP',
        now,
      },
      session,
    ),
  );
  b = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: NAME },
        owner: {
          name: 'Owner B',
          email: emailB.toUpperCase(),
          password: PASSWORD,
          emailVerified: true,
        },
        status: 'ACTIVE',
        signupSource: 'PLATFORM',
      },
      session,
    ),
  );
});

afterAll(async () => {
  for (const org of [a, b]) if (org) await cleanupOrg(org.orgId);
  await disconnectDatabase();
});

describe('provisionOrg', () => {
  it('creates two distinct businesses with unique slugs', async () => {
    expect(String(a.orgId)).not.toBe(String(b.orgId));
    expect(a.slug).not.toBe(b.slug);
    expect(b.slug).toBe(`${a.slug}-2`);
  });

  it('records the subscription state it was given', async () => {
    const orgA = await Org.findById(a.orgId).lean();
    expect(orgA?.status).toBe('TRIAL');
    expect(orgA?.trialEndsAt?.toISOString()).toBe('2026-10-30T06:00:00.000Z');
    expect(String(orgA?.ownerUserId)).toBe(String(a.ownerUserId));
    expect(orgA?.signupSource).toBe('SIGNUP');

    const orgB = await Org.findById(b.orgId).lean();
    expect(orgB?.status).toBe('ACTIVE');
    expect(orgB?.trialEndsAt).toBeNull();
  });

  it('gives each business its own roles, locations and price tiers', async () => {
    const [rolesA, rolesB] = await Promise.all([
      Role.countDocuments({ orgId: a.orgId, isSystem: true }),
      Role.countDocuments({ orgId: b.orgId, isSystem: true }),
    ]);
    expect(rolesA).toBeGreaterThan(0);
    expect(rolesB).toBe(rolesA);

    const tiers = await PriceTier.countDocuments({ orgId: a.orgId });
    expect(tiers).toBe(4);
    const orgA = await Org.findById(a.orgId).lean();
    expect(orgA?.settings.defaultRetailTierId).not.toBeNull();
  });

  it('lets each owner log in to their own business only', async () => {
    const sessionA = await login({ email: emailA, password: PASSWORD });
    const sessionB = await login({ email: emailB, password: PASSWORD });

    expect(sessionA.user.orgId).toBe(String(a.orgId));
    expect(sessionB.user.orgId).toBe(String(b.orgId));
    expect(sessionA.user.roleCodes).toEqual(['OWNER']);

    const locationsA = await myLocations(sessionA.user);
    expect(locationsA.map((l) => l.code).sort()).toEqual(['MAIN', 'SHOP']);
    const locationsB = await myLocations(sessionB.user);
    const idsA = new Set(locationsA.map((l) => l.id));
    expect(locationsB.some((l) => idsA.has(l.id))).toBe(false);
  });

  it("hides one business's roles from the other", async () => {
    const ownerRoleOfA = a.roleIds.get('OWNER')!;
    const err = await refusal(getRole(b.orgId, ownerRoleOfA));
    expect(err.status).toBe(404);
  });

  it('refuses to provision a second business for an email already in use', async () => {
    const err = await refusal(
      withTransaction((session) =>
        provisionOrg(
          {
            business: { name: `${NAME} again` },
            owner: { name: 'Someone', email: emailA, password: PASSWORD },
            status: 'ACTIVE',
            signupSource: 'SIGNUP',
          },
          session,
        ),
      ),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('EMAIL_TAKEN');
    // And the failed attempt left no half-made business behind.
    expect(await Org.countDocuments({ name: `${NAME} again` })).toBe(0);
  });
});

describe('platform-unique email', () => {
  it("refuses a user in business B with business A's owner email", async () => {
    const err = await refusal(
      createUser(
        b.orgId,
        {
          name: 'Clash',
          email: emailA,
          password: PASSWORD,
          roleIds: [String(b.roleIds.get('SALES_REP'))],
          permissionGrants: [],
          permissionRevokes: [],
          locationIds: [],
        },
        b.ownerUserId,
      ),
    );
    expect(err.code).toBe('EMAIL_TAKEN');
  });

  it("refuses changing a user's email to one taken in another business", async () => {
    const err = await refusal(
      updateUser(b.orgId, b.ownerUserId, { email: emailA }, b.ownerUserId),
    );
    expect(err.code).toBe('EMAIL_TAKEN');
  });

  it('allows saving a user with their own unchanged email', async () => {
    const updated = await updateUser(b.orgId, b.ownerUserId, { email: emailB }, b.ownerUserId);
    expect(updated.email).toBe(emailB);
  });
});
