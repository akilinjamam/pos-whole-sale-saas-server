import { Types } from 'mongoose';

import { config } from '../config/env.js';
import { SYSTEM_ROLES } from '../db/seed/roles.js';
import { baseSlug, slugCandidate, trialEndsAt } from '../domain/tenant.js';
import { ApiError } from '../lib/ApiError.js';
import { Location } from '../modules/location/location.model.js';
import { Org } from '../modules/org/org.model.js';
import { PriceTier } from '../modules/priceTier/priceTier.model.js';
import { Role } from '../modules/role/role.model.js';
import { User } from '../modules/user/user.model.js';

import type { OrgStatus, SignupSource } from '@shared/enums.js';
import type { ClientSession } from 'mongoose';

/**
 * Creating a business — SaaS phase 1.
 *
 * `provisionOrg` is the only way a new tenant comes into existence: the seed script, the public
 * signup (phase 3) and the platform admin (phase 5) all call it. It writes the org, its system
 * roles, its default locations and price tiers, and its owner, in the caller's transaction — a
 * signup that fails half-way leaves nothing behind, not an org nobody can log in to.
 *
 * The `ensure*` helpers are idempotent (upsert on a natural key) so the seed can re-run them.
 */

export interface ProvisionOrgInput {
  business: {
    name: string;
    legalName?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  };
  owner: {
    name: string;
    email: string;
    phone?: string | null;
    /** Plaintext; the User model's pre-save hook hashes it. */
    password: string;
    mustChangePassword?: boolean;
  };
  status: OrgStatus;
  signupSource: SignupSource;
  /** Required when `status` is TRIAL. */
  trialDays?: number;
  planCode?: string | null;
  /** For tests and backfills; defaults to now. */
  now?: Date;
}

export interface ProvisionedOrg {
  orgId: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  slug: string;
  roleIds: Map<string, Types.ObjectId>;
}

const DEFAULT_LOCATIONS = [
  {
    code: 'MAIN',
    name: 'Main Warehouse',
    type: 'WAREHOUSE' as const,
    allowsSales: true,
    allowsPurchase: true,
    sortOrder: 1,
  },
  {
    code: 'SHOP',
    name: 'Shop Counter',
    type: 'COUNTER' as const,
    allowsSales: true,
    allowsPurchase: false,
    sortOrder: 2,
  },
];

/** The four tiers of §6.6, and RETAIL as the counter's default. */
const DEFAULT_PRICE_TIERS = [
  { code: 'RETAIL', name: 'Retail (MRP)', level: 0, description: 'Counter and walk-in prices.' },
  { code: 'DEALER_A', name: 'Dealer A', level: 10, description: null },
  { code: 'DEALER_B', name: 'Dealer B', level: 20, description: null },
  { code: 'DISTRIBUTOR', name: 'Distributor', level: 30, description: null },
];

/** Refuse an email that any user on the platform already has — login finds the org by it. */
export async function assertEmailAvailable(
  email: string,
  options: { exceptUserId?: Types.ObjectId; session?: ClientSession } = {},
): Promise<void> {
  const filter: Record<string, unknown> = { email: email.trim().toLowerCase() };
  if (options.exceptUserId) filter._id = { $ne: options.exceptUserId };
  const taken = await User.exists(filter).session(options.session ?? null);
  if (taken) {
    throw ApiError.conflict('EMAIL_TAKEN', 'This email is already in use', { field: 'email' });
  }
}

/**
 * The first free slug for `name`. The partial unique index on `slug` is the real guarantee; this
 * only keeps the common case from ever reaching it.
 */
export async function uniqueSlug(name: string, session?: ClientSession): Promise<string> {
  const base = baseSlug(name);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = slugCandidate(base, attempt);
    if (!(await Org.exists({ slug: candidate }).session(session ?? null))) return candidate;
  }
  // Fifty businesses with the same name: stop counting and make it unique outright.
  return slugCandidate(base, Number.parseInt(new Types.ObjectId().toHexString().slice(-6), 16));
}

/**
 * Create or refresh the system roles of one org.
 *
 * `permissions` is overwritten on every run: system roles track the catalog, and a role that
 * silently kept a stale set would be the exact drift the seed exists to prevent. Deliberate local
 * edits belong in a *custom* role, which this never touches.
 */
export async function syncSystemRoles(
  orgId: Types.ObjectId,
  session?: ClientSession,
): Promise<Map<string, Types.ObjectId>> {
  const byCode = new Map<string, Types.ObjectId>();
  for (const seed of SYSTEM_ROLES) {
    const role = await Role.findOneAndUpdate(
      { orgId, code: seed.code },
      {
        $set: {
          name: seed.name,
          description: seed.description,
          permissions: [...seed.permissions],
          isSystem: true,
        },
        $setOnInsert: { orgId, code: seed.code },
      },
      { new: true, upsert: true, session },
    );
    byCode.set(seed.code, role._id);
  }
  return byCode;
}

/** `$setOnInsert` only: a warehouse the business renamed survives the next run. */
export async function ensureDefaultLocations(
  orgId: Types.ObjectId,
  session?: ClientSession,
): Promise<Types.ObjectId[]> {
  const ids: Types.ObjectId[] = [];
  for (const seed of DEFAULT_LOCATIONS) {
    const location = await Location.findOneAndUpdate(
      { orgId, code: seed.code },
      { $setOnInsert: { ...seed, orgId } },
      { new: true, upsert: true, session },
    );
    ids.push(location._id);
  }
  return ids;
}

/**
 * `$setOnInsert` only, as for locations. The default-retail setting is written only while it is
 * still unset, so a business that pointed the counter at another tier keeps that choice.
 */
export async function ensureDefaultPriceTiers(
  orgId: Types.ObjectId,
  session?: ClientSession,
): Promise<void> {
  let retailId: Types.ObjectId | null = null;
  for (const seed of DEFAULT_PRICE_TIERS) {
    const tier = await PriceTier.findOneAndUpdate(
      { orgId, code: seed.code },
      { $setOnInsert: { ...seed, orgId, isActive: true } },
      { new: true, upsert: true, session },
    );
    if (seed.code === 'RETAIL') retailId = tier._id;
  }
  if (retailId) {
    await Org.updateOne(
      { _id: orgId, 'settings.defaultRetailTierId': null },
      { $set: { 'settings.defaultRetailTierId': retailId } },
      { session },
    );
  }
}

/** Create a complete, ready-to-use business. Must be called inside `withTransaction`. */
export async function provisionOrg(
  input: ProvisionOrgInput,
  session: ClientSession,
): Promise<ProvisionedOrg> {
  const now = input.now ?? new Date();
  const ownerEmail = input.owner.email.trim().toLowerCase();

  if (input.status === 'TRIAL' && input.trialDays === undefined) {
    throw new Error('provisionOrg: trialDays is required for a TRIAL org');
  }

  await assertEmailAvailable(ownerEmail, { session });
  const slug = await uniqueSlug(input.business.name, session);

  const orgId = new Types.ObjectId();
  const ownerUserId = new Types.ObjectId();

  await Org.create(
    [
      {
        _id: orgId,
        name: input.business.name.trim(),
        legalName: input.business.legalName ?? null,
        phone: input.business.phone ?? null,
        email: input.business.email ?? ownerEmail,
        address: input.business.address ?? null,
        currency: config.locale.currency,
        timeZone: config.locale.timezone,
        fiscalYearStartMonth: 7,
        slug,
        status: input.status,
        planCode: input.planCode ?? null,
        trialEndsAt: input.status === 'TRIAL' ? trialEndsAt(now, input.trialDays) : null,
        currentPeriodEndsAt: null,
        ownerUserId,
        signupSource: input.signupSource,
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
      },
    ],
    { session },
  );

  const roleIds = await syncSystemRoles(orgId, session);
  await ensureDefaultLocations(orgId, session);
  await ensureDefaultPriceTiers(orgId, session);

  const ownerRoleId = roleIds.get('OWNER');
  if (!ownerRoleId) throw new Error('provisionOrg: OWNER role missing from SYSTEM_ROLES');

  // `new` + `save()` so the pre-save hook hashes the password.
  const owner = new User({
    _id: ownerUserId,
    orgId,
    name: input.owner.name.trim(),
    email: ownerEmail,
    phone: input.owner.phone ?? null,
    passwordHash: input.owner.password,
    roleIds: [ownerRoleId],
    // Empty `locationIds` means unrestricted — see `requireLocation`.
    locationIds: [],
    defaultLocationId: null,
    isActive: true,
    mustChangePassword: input.owner.mustChangePassword ?? false,
    createdBy: ownerUserId,
    updatedBy: ownerUserId,
  });
  await owner.save({ session });

  return { orgId, ownerUserId, slug, roleIds };
}
