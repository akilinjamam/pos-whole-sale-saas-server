import { describe, expect, it } from 'vitest';

import {
  isAuthenticateGuard,
  isPlatformAuthenticateGuard,
  permissionsOf,
  platformPermissionsOf,
} from '../src/middleware/guardMeta.js';
import { allRoutes } from '../src/routes/index.js';
import { ALL_PERMISSIONS } from '../src/shared/permissions.js';
import { PLATFORM_PERMISSIONS } from '../src/shared/platform.js';

import type { RequestHandler, Router } from 'express';

/**
 * The regression guard for the retail system's worst flaw.
 *
 * In the retail POS, protection is applied per route by hand, which means it is *forgotten* per
 * route by hand — and a forgotten guard is invisible. Nothing errors, nothing logs, the screen
 * works; the endpoint is simply open, and stays open until somebody notices. There is no way to
 * spot that by reading a diff, because the bug is a line that is not there.
 *
 * So it is asserted mechanically. This walks the real route table, enumerates every mounted
 * (method, path), and fails the build if any of them lacks `authenticate` or
 * `requirePermission`. Adding an unguarded endpoint stops being a silent mistake and becomes a
 * red test.
 *
 * Everything intentionally ungated is listed below with a stated reason. That list is the point
 * of the whole file: exemptions have to be *argued for* in a place reviewers read, rather than
 * being the accidental default.
 */

// ─── Express internals ──────────────────────────────────────────────────────────────────
//
// `Router.stack` is not in @types/express — it is Express's private layer list. Walking it is
// the only way to see what is actually mounted, as opposed to what a route file appears to say.

interface ExpressLayer {
  name: string;
  handle: RequestHandler;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { method?: string; handle: RequestHandler }[];
  };
}

interface RouterWithStack extends Router {
  stack: ExpressLayer[];
}

interface MountedRoute {
  /** e.g. `GET /api/v1/users/:id` — what the test reports on failure. */
  signature: string;
  /** e.g. `users/:id`, used to match the allow-lists. */
  key: string;
  method: string;
  handlers: RequestHandler[];
}

/** Flatten one module's router into its concrete (method, path) endpoints. */
function collectRoutes(mount: string, router: Router): MountedRoute[] {
  const found: MountedRoute[] = [];

  for (const layer of (router as RouterWithStack).stack) {
    if (!layer.route) continue;

    const handlers = layer.route.stack.map((entry) => entry.handle);
    // '/' as a sub-path would render as `users/`; normalise it away.
    const subPath = layer.route.path === '/' ? '' : layer.route.path;

    for (const method of Object.keys(layer.route.methods)) {
      found.push({
        signature: `${method.toUpperCase()} /api/v1/${mount}${subPath}`,
        key: `${mount}${subPath}`,
        method: method.toUpperCase(),
        handlers,
      });
    }
  }

  return found;
}

// ─── The exemption lists ────────────────────────────────────────────────────────────────

/**
 * Reachable with no token at all.
 *
 * Keep this to things that *cannot* require a credential, and say why for each.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  health:
    'Liveness probe. Reports no data beyond uptime and topology, and monitoring cannot hold a token.',
  'auth/login': 'Obtaining a token is its purpose — requiring one would be circular.',
  'auth/refresh':
    'Same: it is the endpoint you call precisely because your access token is no longer usable.',
  'auth/signup':
    'Creating a business and its first account — the caller has no account yet. Rate-limited per ' +
    'IP, switchable off with SIGNUP_ENABLED, and the owner cannot add users until verified.',
  'auth/verify-email':
    'Opened from an email link, often on another device with no session. The single-use, ' +
    'hashed, expiring token in the body is the credential.',
  'auth/forgot-password':
    'For someone who cannot sign in. Answers the same for unknown addresses, and is rate-limited.',
  'auth/reset-password':
    'Same as verify-email: the single-use token from the email is the credential.',
};

/**
 * Authenticated, but deliberately carrying no `requirePermission`.
 *
 * These act on the caller's *own* account, so the credential is the authorisation — there is no
 * separate capability to check. Gating `/auth/me` behind a permission would lock a user out of
 * the very screen whose job is to tell them what permissions they have.
 */
const SELF_SERVICE_ROUTES: Record<string, string> = {
  'auth/me': "Returns the caller's own identity; the token is the authorisation.",
  'auth/me/locations':
    "The caller's own accessible locations, for the topbar switcher. Scoped by their " +
    '`locationIds`, so it discloses nothing they could not already act on — and a cashier ' +
    'must be able to choose their till without holding `location:read`.',
  'auth/logout': "Ends the caller's own session. A user must always be able to sign out.",
  'auth/password': "Changes the caller's own password, and re-checks the current one itself.",
  'org/subscription':
    "The caller's own business's plan, status and usage. Every user — a cashier included — must " +
    'be able to see that the business is read-only and why; it discloses counts, not records.',
  'auth/resend-verification':
    "Re-sends the caller's own verification email; a 60-second cooldown stops it being spammed.",
  notifications:
    'Every signed-in user has a bell. Each kind is included only for those who hold the ' +
    'permission of the screen it links to (expiry → stock:read, low stock → po:read, overdue → ' +
    'payment:read, approvals → order:approve) — the rest get an empty list.',
  dashboard:
    'Every signed-in user has a home page. Each section inside is included only when the caller ' +
    'holds the permission of the report behind it (sales → report:sales, receivables → ' +
    'payment:read, low stock → po:read, dispatch → order:read) — a cashier gets an empty one.',
};

/**
 * Platform routes (SaaS phase 5) reachable with no platform token — the same argument as above.
 */
const PLATFORM_PUBLIC_ROUTES: Record<string, string> = {
  'platform/auth/login': 'Obtaining a platform token is its purpose. Rate-limited per IP.',
};

/** Platform routes that act on the signed-in admin's own account, so carry no permission. */
const PLATFORM_SELF_SERVICE_ROUTES: Record<string, string> = {
  'platform/auth/me': "The admin's own identity and permissions.",
  'platform/auth/logout': "Ends the admin's own sessions.",
  'platform/auth/password': "Changes the admin's own password, re-checking the current one.",
};

// ─── The test ───────────────────────────────────────────────────────────────────────────

const everything = allRoutes.flatMap((entry) => collectRoutes(entry.path, entry.route));
const isPlatform = (route: MountedRoute) => route.key === 'platform' || route.key.startsWith('platform/');
/** Tenant routes — every assertion in the first block is about these. */
const mounted = everything.filter((route) => !isPlatform(route));
const platformRoutes = everything.filter(isPlatform);

describe('route coverage', () => {
  it('finds routes to check (the walk itself works)', () => {
    // Without this, a change to Express's internals that silently empties `stack` would make
    // every assertion below pass vacuously — a green suite proving nothing.
    expect(mounted.length).toBeGreaterThan(10);
  });

  it('every route is authenticated unless explicitly listed as public', () => {
    const offenders = mounted
      .filter((route) => !(route.key in PUBLIC_ROUTES))
      .filter((route) => !route.handlers.some(isAuthenticateGuard))
      .map((route) => route.signature);

    expect(
      offenders,
      `These routes have no \`authenticate\`:\n  ${offenders.join('\n  ')}\n\n` +
        'Add it, or add the path to PUBLIC_ROUTES in this file with a reason.',
    ).toEqual([]);
  });

  it('every authenticated route gates on a permission unless it is self-service', () => {
    const exempt = { ...PUBLIC_ROUTES, ...SELF_SERVICE_ROUTES };

    const offenders = mounted
      .filter((route) => !(route.key in exempt))
      .filter((route) => !route.handlers.some((h) => permissionsOf(h) !== null))
      .map((route) => route.signature);

    expect(
      offenders,
      `These routes have no \`requirePermission\`:\n  ${offenders.join('\n  ')}\n\n` +
        'Add one, or add the path to SELF_SERVICE_ROUTES in this file with a reason.',
    ).toEqual([]);
  });

  it('every gated permission exists in the catalog', () => {
    // `requirePermission` is typed against `Permission`, so this cannot fail while the guard is
    // called normally. It catches the case the type system cannot see: a permission removed
    // from the catalog while a route still demands it, which would deny everyone silently.
    const known = new Set<string>(ALL_PERMISSIONS);

    const unknown: string[] = [];
    for (const route of mounted) {
      for (const handler of route.handlers) {
        for (const permission of permissionsOf(handler) ?? []) {
          if (!known.has(permission)) unknown.push(`${route.signature} → "${permission}"`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });

  it('exemption lists contain no stale entries', () => {
    // An exemption for a route that no longer exists is a trap: the path gets reused later and
    // silently inherits an exemption nobody meant to grant.
    const keys = new Set(mounted.map((route) => route.key));
    const stale = [...Object.keys(PUBLIC_ROUTES), ...Object.keys(SELF_SERVICE_ROUTES)].filter(
      (key) => !keys.has(key),
    );

    expect(stale, `Exempted paths that are not mounted: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('platform route coverage (SaaS phase 5)', () => {
  it('finds platform routes to check', () => {
    expect(platformRoutes.length).toBeGreaterThan(10);
  });

  it('every platform route has authenticatePlatform unless listed as public', () => {
    const offenders = platformRoutes
      .filter((route) => !(route.key in PLATFORM_PUBLIC_ROUTES))
      .filter((route) => !route.handlers.some(isPlatformAuthenticateGuard))
      .map((route) => route.signature);
    expect(offenders, `No authenticatePlatform:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('every authenticated platform route gates on a platform permission unless self-service', () => {
    const exempt = { ...PLATFORM_PUBLIC_ROUTES, ...PLATFORM_SELF_SERVICE_ROUTES };
    const offenders = platformRoutes
      .filter((route) => !(route.key in exempt))
      .filter((route) => !route.handlers.some((h) => platformPermissionsOf(h) !== null))
      .map((route) => route.signature);
    expect(offenders, `No requirePlatformPermission:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('platform and tenant guards never cross over', () => {
    const crossed = [
      ...platformRoutes
        .filter((r) => r.handlers.some((h) => isAuthenticateGuard(h) || permissionsOf(h) !== null))
        .map((r) => `${r.signature} carries a tenant guard`),
      ...mounted
        .filter((r) => r.handlers.some((h) => isPlatformAuthenticateGuard(h) || platformPermissionsOf(h) !== null))
        .map((r) => `${r.signature} carries a platform guard`),
    ];
    expect(crossed).toEqual([]);
  });

  it('every gated platform permission exists in the platform catalog', () => {
    const known = new Set<string>(PLATFORM_PERMISSIONS);
    const unknown = platformRoutes.flatMap((r) =>
      r.handlers.flatMap((h) => (platformPermissionsOf(h) ?? []).filter((p) => !known.has(p))),
    );
    expect(unknown).toEqual([]);
  });

  it('platform exemption lists contain no stale entries', () => {
    const keys = new Set(platformRoutes.map((route) => route.key));
    const stale = [...Object.keys(PLATFORM_PUBLIC_ROUTES), ...Object.keys(PLATFORM_SELF_SERVICE_ROUTES)].filter(
      (key) => !keys.has(key),
    );
    expect(stale).toEqual([]);
  });
});
