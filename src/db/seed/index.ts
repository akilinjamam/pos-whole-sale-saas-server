import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { Org } from '../../modules/org/org.model.js';
import { DEFAULT_PLANS, Plan } from '../../modules/plan/plan.model.js';
import { User } from '../../modules/user/user.model.js';
import {
  provisionOrg,
  syncSystemRoles,
  uniqueSlug,
} from '../../services/provisioning.service.js';

import type { Types } from 'mongoose';

/**
 * Bring the database to a state the system can be logged into, and keep every business in step
 * with the code.
 *
 *   npm run seed
 *
 * **Idempotent by design**, and run on every deploy (docs/DEPLOY.md):
 *
 *  1. Moves the users collection to platform-unique emails (SaaS phase 1), refusing — with the
 *     clashing addresses listed — if two users already share one.
 *  2. Provisions the first business and its owner from `SEED_ADMIN_*`, only on an empty database.
 *     New businesses after that come from signup or the platform admin, never from here.
 *  3. For **every** business: backfills a missing slug, and re-syncs the system roles so new
 *     permissions in the catalog reach each OWNER.
 *  4. In development only, demo users for the first business.
 *
 * It never overwrites a password and never re-creates a location or price tier a business has
 * changed — those are written only when a business is provisioned.
 */

const ADMIN_EMAIL_FALLBACK = 'admin@optical.local';
const ADMIN_PASSWORD_FALLBACK = 'ChangeMe123!';

/** The index that made email unique per org only; replaced by a platform-wide `email_1`. */
const LEGACY_EMAIL_INDEX = 'orgId_1_email_1';

async function migrateUserEmailIndex(): Promise<void> {
  const clashes = await User.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$email', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  if (clashes.length > 0) {
    logger.fatal(
      { emails: clashes.map((c) => `${c._id} ×${c.count}`) },
      'These emails belong to more than one user. Emails must be unique across the platform — change them, then re-run the seed.',
    );
    throw new Error('Duplicate user emails');
  }

  await User.createIndexes();

  const existing = await User.collection.indexes();
  if (existing.some((index) => index.name === LEGACY_EMAIL_INDEX)) {
    await User.collection.dropIndex(LEGACY_EMAIL_INDEX);
    logger.info({ index: LEGACY_EMAIL_INDEX }, 'Dropped the per-org email index');
  }
}

/** The default plans, inserted only when missing — a plan edited by the platform admin is kept. */
async function seedPlans(): Promise<void> {
  let added = 0;
  for (const plan of DEFAULT_PLANS) {
    const res = await Plan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
    added += res.upsertedCount;
  }
  if (added > 0) {
    logger.warn(
      { added, codes: DEFAULT_PLANS.map((p) => p.code) },
      'Default plans inserted — their prices and limits are PLACEHOLDERS; set the real ones before launch',
    );
  }
}

async function seedFirstOrg(): Promise<void> {
  if (await Org.exists({})) {
    logger.info('Businesses already present — not provisioning a new one');
    return;
  }

  const email = (config.seed.adminEmail ?? ADMIN_EMAIL_FALLBACK).toLowerCase();
  const password = config.seed.adminPassword ?? ADMIN_PASSWORD_FALLBACK;

  const created = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: 'Optical Wholesale' },
        owner: {
          name: 'Administrator',
          email,
          password,
          mustChangePassword: !config.seed.adminPassword,
          emailVerified: true,
        },
        status: 'ACTIVE',
        signupSource: 'SEED',
      },
      session,
    ),
  );

  logger.info({ slug: created.slug, email }, 'First business and its owner created');

  if (!config.seed.adminPassword) {
    logger.warn(
      { email, password: ADMIN_PASSWORD_FALLBACK },
      'Seeded the owner with the DEFAULT password and mustChangePassword — set SEED_ADMIN_PASSWORD in .env to choose your own',
    );
  }
}

/**
 * Backfill and role sync, for every business on the platform.
 *
 * An org created before SaaS phase 1 has none of the subscription fields on disk. Mongoose fills
 * the defaults when it hydrates a document, but a *query* such as `{ status: 'ACTIVE' }` would
 * still miss it — so they are written for real.
 */
async function syncAllOrgs(): Promise<void> {
  const orgs = await Org.find()
    .select('name slug ownerUserId')
    .sort({ createdAt: 1 })
    .lean();

  for (const org of orgs) {
    const set: Record<string, unknown> = {};

    if (!org.slug) set.slug = await uniqueSlug(org.name);

    if (!org.ownerUserId) {
      const roleIds = await syncSystemRoles(org._id);
      const owner = await User.findOne({ orgId: org._id, roleIds: roleIds.get('OWNER') })
        .sort({ createdAt: 1 })
        .select('_id')
        .lean();
      if (owner) set.ownerUserId = owner._id;
    }

    if (Object.keys(set).length > 0) {
      await Org.updateOne({ _id: org._id }, { $set: set });
      logger.info({ org: org.name, ...set }, 'Business backfilled');
    }

    await syncSystemRoles(org._id);
  }

  const legacy = await Org.updateMany(
    { status: { $exists: false } },
    {
      $set: {
        status: 'ACTIVE',
        signupSource: 'SEED',
        planCode: null,
        trialEndsAt: null,
        currentPeriodEndsAt: null,
      },
    },
  );
  if (legacy.modifiedCount > 0) {
    logger.info({ count: legacy.modifiedCount }, 'Subscription fields backfilled as ACTIVE');
  }

  // Users from before email verification existed were created by someone who knew them; treat
  // their addresses as verified rather than locking every existing owner out of adding staff.
  const unverified = await User.updateMany({ emailVerifiedAt: { $exists: false } }, [
    { $set: { emailVerifiedAt: '$createdAt' } },
  ]);
  if (unverified.modifiedCount > 0) {
    logger.info({ count: unverified.modifiedCount }, 'Existing users marked as verified');
  }

  logger.info({ businesses: orgs.length }, 'System roles synced for every business');
}

/**
 * One account per system role in the first business, so the difference between them can be seen
 * rather than described. Opt-in (`SEED_DEMO_USERS=true`) and refused in production — see
 * `config.seed`.
 *
 * `locationIds` is empty on all of them: the point of these accounts is to demonstrate the
 * *permission* split, and restricting locations as well would make a missing screen ambiguous
 * between "this role cannot" and "this user's warehouse cannot".
 */
async function seedDemoUsers(): Promise<void> {
  if (!config.seed.demoUsers) return;

  const first = await Org.findOne().sort({ createdAt: 1 }).select('_id').lean();
  if (!first) return;
  const roleIds = await syncSystemRoles(first._id);

  const demos = [
    { code: 'SALES_MANAGER', email: 'salesmanager@optical.local', name: 'Demo Sales Manager' },
    { code: 'SALES_REP', email: 'salesrep@optical.local', name: 'Demo Sales Rep' },
    { code: 'STORE_KEEPER', email: 'storekeeper@optical.local', name: 'Demo Store Keeper' },
    { code: 'ACCOUNTS', email: 'accounts@optical.local', name: 'Demo Accounts' },
    { code: 'POS_CASHIER', email: 'cashier@optical.local', name: 'Demo Cashier' },
  ];

  const created: string[] = [];

  for (const demo of demos) {
    const roleId: Types.ObjectId | undefined = roleIds.get(demo.code);
    if (!roleId) continue;

    // Emails are platform-wide, so check everywhere — and never rewrite an existing password.
    if (await User.exists({ email: demo.email })) continue;

    const user = new User({
      orgId: first._id,
      name: demo.name,
      email: demo.email,
      passwordHash: config.seed.demoPassword, // hashed by the model's pre-save hook
      roleIds: [roleId],
      locationIds: [],
      defaultLocationId: null,
      isActive: true,
      mustChangePassword: false,
      emailVerifiedAt: new Date(),
    });
    await user.save();
    created.push(demo.email);
  }

  if (created.length > 0) {
    logger.warn(
      { users: created, password: config.seed.demoPassword },
      'Demo users created with a SHARED, KNOWN password — never enable SEED_DEMO_USERS outside development',
    );
  }
}

async function main(): Promise<void> {
  await connectDatabase();

  await migrateUserEmailIndex();
  await seedPlans();
  await seedFirstOrg();
  await syncAllOrgs();
  await seedDemoUsers();

  logger.info('Seed complete');
  await disconnectDatabase();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Seed failed');
  process.exit(1);
});
