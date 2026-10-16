import type { Permission } from '@shared/permissions.js';
import type { PlatformPermission } from '@shared/platform.js';
import type { RequestHandler } from 'express';

/**
 * Markers that let a guard be recognised after it has been mounted on a router.
 *
 * The route-coverage test walks `routes/index.ts`, pulls every handler off every route, and
 * asserts that `authenticate` and `requirePermission` are both present. To do that it has to
 * be able to tell one middleware function from another once they are sitting in an Express
 * layer stack — and by then the useful information is gone:
 *
 *  - `requirePermission('order:read')` returns a **fresh closure** on every call, so there is
 *    no reference to compare against and `fn.name` is the same for all of them.
 *  - Matching on source text or on parameter names would pass for anything shaped like a
 *    guard, which is exactly the false negative the test exists to prevent.
 *
 * So each guard states what it is, in a way that survives being passed around. `Symbol.for`
 * rather than a bare string key keeps it out of `Object.keys` and makes an accidental
 * collision with an unrelated property impossible.
 */

export const IS_AUTHENTICATE = Symbol.for('pos.guard.authenticate');
export const REQUIRED_PERMISSIONS = Symbol.for('pos.guard.requiredPermissions');

export interface AuthenticateGuard extends RequestHandler {
  [IS_AUTHENTICATE]: true;
}

export interface PermissionGuard extends RequestHandler {
  [REQUIRED_PERMISSIONS]: readonly Permission[];
}

/** Tag a handler as the authentication guard. */
export function markAuthenticate(handler: RequestHandler): AuthenticateGuard {
  return Object.defineProperty(handler, IS_AUTHENTICATE, {
    value: true,
    enumerable: false,
  }) as AuthenticateGuard;
}

/** Tag a handler as a permission gate, recording which permissions it demands. */
export function markPermissions(
  handler: RequestHandler,
  permissions: readonly Permission[],
): PermissionGuard {
  return Object.defineProperty(handler, REQUIRED_PERMISSIONS, {
    value: permissions,
    enumerable: false,
  }) as PermissionGuard;
}

export function isAuthenticateGuard(handler: unknown): boolean {
  return typeof handler === 'function' && IS_AUTHENTICATE in handler;
}

export function permissionsOf(handler: unknown): readonly Permission[] | null {
  if (typeof handler !== 'function' || !(REQUIRED_PERMISSIONS in handler)) return null;
  return (handler as PermissionGuard)[REQUIRED_PERMISSIONS];
}

// ─── Platform guards (SaaS phase 5) ─────────────────────────────────────────────────────
//
// Their own markers, not the tenant ones: a platform route guarded by a tenant `authenticate`
// — or a tenant route by `authenticatePlatform` — must fail the coverage test, not pass it.

export const IS_PLATFORM_AUTHENTICATE = Symbol.for('pos.guard.platformAuthenticate');
export const REQUIRED_PLATFORM_PERMISSIONS = Symbol.for(
  'pos.guard.requiredPlatformPermissions',
);

export function markPlatformAuthenticate(handler: RequestHandler): RequestHandler {
  return Object.defineProperty(handler, IS_PLATFORM_AUTHENTICATE, {
    value: true,
    enumerable: false,
  });
}

export function markPlatformPermissions(
  handler: RequestHandler,
  permissions: readonly PlatformPermission[],
): RequestHandler {
  return Object.defineProperty(handler, REQUIRED_PLATFORM_PERMISSIONS, {
    value: permissions,
    enumerable: false,
  });
}

export function isPlatformAuthenticateGuard(handler: unknown): boolean {
  return typeof handler === 'function' && IS_PLATFORM_AUTHENTICATE in handler;
}

export function platformPermissionsOf(handler: unknown): readonly PlatformPermission[] | null {
  if (typeof handler !== 'function' || !(REQUIRED_PLATFORM_PERMISSIONS in handler)) return null;
  return (handler as unknown as Record<symbol, readonly PlatformPermission[]>)[
    REQUIRED_PLATFORM_PERMISSIONS
  ]!;
}
