import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { resolveAccess, resolveAccessMany } from '../../services/identity.service.js';
import { assertEmailAvailable } from '../../services/provisioning.service.js';
import { assertWithinLimit } from '../../services/subscription.service.js';
import { Location } from '../location/location.model.js';
import { Role } from '../role/role.model.js';

import { User, toUserPayload } from './user.model.js';

import type {
  CreateUserInput,
  ListUsersQuery,
  ResetPasswordInput,
  UpdateUserInput,
} from './user.schema.js';
import type { UserDoc } from './user.model.js';
import type { PageMeta, UserPayload } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

const SORTABLE = ['name', 'email', 'lastLoginAt', 'createdAt'] as const;

/** What the search box looks at. `phone` included: it is how staff are often looked up. */
const SEARCHABLE = ['name', 'email', 'phone'] as const;

/**
 * Referential checks the schema cannot do.
 *
 * Zod proves the ids are well-formed; only the database can say whether they exist and belong
 * to this org. Without this, a typo'd role id produces a user with no effective permissions and
 * no error — they simply find every screen missing and nobody can explain why.
 */
async function assertReferencesExist(
  orgId: Types.ObjectId,
  roleIds: string[] | undefined,
  locationIds: string[] | undefined,
): Promise<void> {
  if (roleIds && roleIds.length > 0) {
    const found = await Role.countDocuments({ orgId, _id: { $in: roleIds } });
    if (found !== new Set(roleIds).size) {
      throw ApiError.validation('Validation failed', [
        { path: 'roleIds', message: 'One or more roles do not exist' },
      ]);
    }
  }

  if (locationIds && locationIds.length > 0) {
    const found = await Location.countDocuments({ orgId, _id: { $in: locationIds } });
    if (found !== new Set(locationIds).size) {
      throw ApiError.validation('Validation failed', [
        { path: 'locationIds', message: 'One or more locations do not exist' },
      ]);
    }
  }
}

export async function listUsers(
  orgId: Types.ObjectId,
  query: ListUsersQuery,
): Promise<{ items: UserPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<UserDoc> = { orgId };
  if (query.roleId) filter.roleIds = new Types.ObjectId(query.roleId);
  if (query.locationId) filter.locationIds = new Types.ObjectId(query.locationId);
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  const { items, meta } = await paginate<UserDoc>(User, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { name: 1 },
    // The aggregation pipeline bypasses `select: false`, so the hash must be excluded here
    // explicitly. This is the one place in the codebase where that safety net does not apply.
    exclude: ['passwordHash'],
  });

  const access = await resolveAccessMany(items);

  return {
    items: items.map((u) => {
      const resolved = access.get(String(u._id));
      return toUserPayload(u, resolved?.permissions ?? [], resolved?.roleCodes ?? []);
    }),
    meta,
  };
}

export async function getUser(orgId: Types.ObjectId, id: Types.ObjectId): Promise<UserPayload> {
  const user = await User.findOne({ _id: id, orgId }).lean();
  if (!user) throw ApiError.notFound('User');

  const { permissions, roleCodes } = await resolveAccess(user);
  return toUserPayload(user, permissions, roleCodes);
}

/**
 * An owner who has not verified their email cannot add staff (SaaS phase 3): otherwise a signup
 * with someone else's address could go on to create accounts in their name. An actor with no user
 * document (a script, a test) is not held to it.
 */
async function assertActorVerified(
  orgId: Types.ObjectId,
  actorId: Types.ObjectId,
): Promise<void> {
  const actor = await User.findOne({ _id: actorId, orgId }).select('emailVerifiedAt').lean();
  if (actor && !actor.emailVerifiedAt) {
    throw new ApiError(
      403,
      'EMAIL_NOT_VERIFIED',
      'Verify your email address before adding users — check your inbox for the link',
    );
  }
}

export async function createUser(
  orgId: Types.ObjectId,
  input: CreateUserInput,
  actorId: Types.ObjectId,
): Promise<UserPayload> {
  await assertActorVerified(orgId, actorId);
  if (input.isActive !== false) await assertWithinLimit(orgId, 'users');
  await assertReferencesExist(orgId, input.roleIds, input.locationIds);
  // Platform-wide, not per org: login finds the business by the email alone.
  await assertEmailAvailable(input.email);

  const { password, ...rest } = input;

  // `passwordHash` receives the plaintext and the pre-save hook hashes it — which is why this
  // must be `new` + `save()` and not `insertMany` or `create` with `lean`, both of which would
  // store it verbatim.
  const user = new User({
    ...rest,
    orgId,
    passwordHash: password,
    createdBy: actorId,
    updatedBy: actorId,
  });
  await user.save();

  const doc = user.toObject();
  const { permissions, roleCodes } = await resolveAccess(doc);
  return toUserPayload(doc, permissions, roleCodes);
}

/**
 * Any change to roles, grants, revokes or active status bumps `tokenVersion`, so the user's
 * existing access token stops working on their next request rather than fifteen minutes later.
 * A rename does not — it changes nothing about what they may do.
 */
function affectsAccess(input: UpdateUserInput): boolean {
  return (
    input.roleIds !== undefined ||
    input.permissionGrants !== undefined ||
    input.permissionRevokes !== undefined ||
    input.locationIds !== undefined ||
    input.isActive !== undefined
  );
}

export async function updateUser(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateUserInput,
  actorId: Types.ObjectId,
): Promise<UserPayload> {
  await assertReferencesExist(orgId, input.roleIds, input.locationIds);
  if (input.email !== undefined) await assertEmailAvailable(input.email, { exceptUserId: id });
  // Switching a user back on takes a seat in the plan, as creating one does.
  if (input.isActive === true && (await User.exists({ _id: id, orgId, isActive: false }))) {
    await assertWithinLimit(orgId, 'users');
  }

  const update: Record<string, unknown> = { ...input, updatedBy: actorId };

  const user = await User.findOneAndUpdate(
    { _id: id, orgId },
    affectsAccess(input) ? { $set: update, $inc: { tokenVersion: 1 } } : { $set: update },
    { new: true, runValidators: true },
  ).lean();

  if (!user) throw ApiError.notFound('User');

  const { permissions, roleCodes } = await resolveAccess(user);
  return toUserPayload(user, permissions, roleCodes);
}

/**
 * An administrator resetting somebody's password.
 *
 * The bump is not optional here: a password reset must invalidate every session the previous
 * password could have opened, which is the entire reason one gets reset.
 */
export async function resetPassword(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: ResetPasswordInput,
  actorId: Types.ObjectId,
): Promise<void> {
  const user = await User.findOne({ _id: id, orgId }).select('+passwordHash');
  if (!user) throw ApiError.notFound('User');

  user.passwordHash = input.password; // hashed by the pre-save hook
  user.mustChangePassword = input.mustChangePassword;
  user.tokenVersion += 1;
  user.updatedBy = actorId;
  await user.save();
}

/**
 * Deactivation, not deletion — the same reasoning as locations, with more force: `createdBy`
 * on every invoice, receipt and stock movement points here, and "who posted this" is the first
 * question asked when a number looks wrong.
 */
export async function deactivateUser(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  actorId: Types.ObjectId,
): Promise<UserPayload> {
  if (String(id) === String(actorId)) {
    throw ApiError.conflict('VALIDATION_FAILED', 'You cannot deactivate your own account');
  }

  const user = await User.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { isActive: false, updatedBy: actorId }, $inc: { tokenVersion: 1 } },
    { new: true },
  ).lean();

  if (!user) throw ApiError.notFound('User');

  const { permissions, roleCodes } = await resolveAccess(user);
  return toUserPayload(user, permissions, roleCodes);
}
