import { describe, expect, it } from 'vitest';

import { isAuthenticateGuard, permissionsOf } from '../src/middleware/guardMeta.js';
import { allRoutes } from '../src/routes/index.js';
import { ALL_PERMISSIONS } from '../src/shared/permissions.js';

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
  dashboard:
    'Every signed-in user has a home page. Each section inside is included only when the caller ' +
    'holds the permission of the report behind it (sales → report:sales, receivables → ' +
    'payment:read, low stock → po:read, dispatch → order:read) — a cashier gets an empty one.',
};

// ─── The test ───────────────────────────────────────────────────────────────────────────

const mounted = allRoutes.flatMap((entry) => collectRoutes(entry.path, entry.route));

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
