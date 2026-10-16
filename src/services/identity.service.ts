import { Role } from '../modules/role/role.model.js';
import { effectivePermissions } from '../shared/permissions.js';
import { idToString, idsToStrings } from '../lib/model.js';

import type { UserDoc } from '../modules/user/user.model.js';
import type { AuthUser } from '@shared/types.js';
import type { Permission } from '@shared/permissions.js';
import type { Types } from 'mongoose';

/**
 * Resolving a user to what they may actually do — the one place it happens.
 *
 * Three callers need this answer and they must agree exactly: `/auth/login` (to embed the set
 * in the token), `authenticate` (which re-derives it from the database on **every** request,
 * so a role change takes effect immediately rather than whenever the token expires), and the
 * users list (to show an administrator the consequence of a grant before they save it).
 *
 * Lives in `services/` rather than the user module because it reads across two collections.
 */

/** Role code and permissions, keyed by role id — one query for a batch of users. */
type RoleIndex = Map<string, { code: string; permissions: string[] }>;

async function loadRoles(roleIds: readonly (Types.ObjectId | string)[]): Promise<RoleIndex> {
  if (roleIds.length === 0) return new Map();

  const roles = await Role.find({ _id: { $in: roleIds } })
    .select('code permissions')
    .lean();

  return new Map(
    roles.map((r) => [String(r._id), { code: r.code, permissions: r.permissions }]),
  );
}

export interface ResolvedAccess {
  permissions: Permission[];
  roleCodes: string[];
}

/** The effective set for one user: `union(roles) ∪ grants \ revokes`, in catalog order. */
export async function resolveAccess(user: UserDoc): Promise<ResolvedAccess> {
  const index = await loadRoles(user.roleIds);

  const fromRoles: string[] = [];
  const roleCodes: string[] = [];
  for (const id of user.roleIds) {
    const role = index.get(String(id));
    if (!role) continue; // A role deleted out from under the user grants nothing.
    fromRoles.push(...role.permissions);
    roleCodes.push(role.code);
  }

  return {
    permissions: effectivePermissions(fromRoles, user.permissionGrants, user.permissionRevokes),
    roleCodes,
  };
}

/**
 * Same resolution for a list of users, with one round trip for all their roles rather than
 * one per user — the users screen would otherwise issue N+1 queries to render a table.
 */
export async function resolveAccessMany(
  users: readonly UserDoc[],
): Promise<Map<string, ResolvedAccess>> {
  const allRoleIds = [...new Set(users.flatMap((u) => u.roleIds.map((id) => String(id))))];
  const index = await loadRoles(allRoleIds);

  const out = new Map<string, ResolvedAccess>();
  for (const user of users) {
    const fromRoles: string[] = [];
    const roleCodes: string[] = [];
    for (const id of user.roleIds) {
      const role = index.get(String(id));
      if (!role) continue;
      fromRoles.push(...role.permissions);
      roleCodes.push(role.code);
    }
    out.set(String(user._id), {
      permissions: effectivePermissions(
        fromRoles,
        user.permissionGrants,
        user.permissionRevokes,
      ),
      roleCodes,
    });
  }
  return out;
}

/** The caller, as `req.user` and as `/auth/me` return them. */
export async function toAuthUser(user: UserDoc): Promise<AuthUser> {
  const { permissions, roleCodes } = await resolveAccess(user);

  return {
    id: String(user._id),
    orgId: String(user.orgId),
    name: user.name,
    email: user.email,
    roleIds: idsToStrings(user.roleIds),
    roleCodes,
    permissions,
    locationIds: idsToStrings(user.locationIds),
    defaultLocationId: idToString(user.defaultLocationId),
    mustChangePassword: user.mustChangePassword,
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}
