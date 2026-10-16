import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { assertWithinLimit } from '../../services/subscription.service.js';

import { Location, toLocationPayload } from './location.model.js';

import type {
  CreateLocationInput,
  ListLocationsQuery,
  UpdateLocationInput,
} from './location.schema.js';
import type { LocationDoc } from './location.model.js';
import type { LocationPayload, PageMeta } from '@shared/types.js';
import type { AuthUser } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/** Sortable fields, whitelisted — `paginate` ignores anything outside this list. */
const SORTABLE = ['code', 'name', 'type', 'sortOrder', 'createdAt'] as const;

/** What the search box looks at. See `searchFields` in `lib/paginate.ts`. */
const SEARCHABLE = ['code', 'name', 'address'] as const;

/**
 * Reads are scoped twice: by `orgId` from the token, and — for a user with an explicit
 * location list — to their own locations. A store keeper assigned to one warehouse has no
 * business enumerating the others, and hiding them in the UI is not scoping.
 */
function scopeFilter(user: AuthUser, orgId: Types.ObjectId): FilterQuery<LocationDoc> {
  const filter: FilterQuery<LocationDoc> = { orgId };
  if (user.locationIds.length > 0) {
    // Cast explicitly. `AuthUser.locationIds` are strings, and `paginate` runs an aggregation
    // pipeline — which, unlike `find`, does **not** cast against the schema. A raw string here
    // matches nothing, so a scoped user would silently see an empty list rather than an error.
    filter._id = { $in: user.locationIds.map((id) => new Types.ObjectId(id)) };
  }
  return filter;
}

export async function listLocations(
  user: AuthUser,
  orgId: Types.ObjectId,
  query: ListLocationsQuery,
): Promise<{ items: LocationPayload[]; meta: PageMeta }> {
  const filter = scopeFilter(user, orgId);
  if (query.type) filter.type = query.type;
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  const { items, meta } = await paginate<LocationDoc>(Location, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { sortOrder: 1, code: 1 },
  });

  return { items: items.map(toLocationPayload), meta };
}

export async function getLocation(
  user: AuthUser,
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<LocationPayload> {
  const doc = await Location.findOne({ ...scopeFilter(user, orgId), _id: id }).lean();
  if (!doc) throw ApiError.notFound('Location');
  return toLocationPayload(doc);
}

export async function createLocation(
  orgId: Types.ObjectId,
  input: CreateLocationInput,
  actorId: Types.ObjectId,
): Promise<LocationPayload> {
  if (input.isActive !== false) await assertWithinLimit(orgId, 'locations');
  // The `{orgId, code}` unique index is the real guard; the duplicate surfaces as a 409 from
  // errorHandler. Checking first as well would only add a race, not remove one.
  const doc = await Location.create({
    ...input,
    orgId,
    createdBy: actorId,
    updatedBy: actorId,
  });
  return toLocationPayload(doc.toObject());
}

export async function updateLocation(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateLocationInput,
  actorId: Types.ObjectId,
): Promise<LocationPayload> {
  // Switching a location back on takes a place in the plan, as creating one does.
  if (input.isActive === true && (await Location.exists({ _id: id, orgId, isActive: false }))) {
    await assertWithinLimit(orgId, 'locations');
  }
  const doc = await Location.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { ...input, updatedBy: actorId } },
    { new: true, runValidators: true },
  ).lean();

  if (!doc) throw ApiError.notFound('Location');
  return toLocationPayload(doc);
}

/**
 * Deactivation, not deletion.
 *
 * Stock ledger rows, balances and every posted document reference `locationId`. Removing the
 * document would leave them pointing at nothing, and a report that cannot name the warehouse a
 * movement happened in is not an audit trail. `isActive: false` hides it from every picker
 * while the history stays intact.
 */
export async function deactivateLocation(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  actorId: Types.ObjectId,
): Promise<LocationPayload> {
  const doc = await Location.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { isActive: false, updatedBy: actorId } },
    { new: true },
  ).lean();

  if (!doc) throw ApiError.notFound('Location');
  return toLocationPayload(doc);
}
