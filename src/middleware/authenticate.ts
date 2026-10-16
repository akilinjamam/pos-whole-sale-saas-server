import { ApiError } from '../lib/ApiError.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { extractBearerToken, verifyAccessToken } from '../lib/tokens.js';
import { User } from '../modules/user/user.model.js';
import { SAFE_METHODS } from '../domain/subscription.js';
import { toAuthUser } from '../services/identity.service.js';
import { orgAccess } from '../services/subscription.service.js';

import { markAuthenticate } from './guardMeta.js';

import type { RequestHandler } from 'express';

/**
 * Verify the bearer token and populate a typed `req.user`.
 *
 * **The token is proof of identity, not a statement of authority.** It carries a permission
 * set so the client can render its menu immediately, but this middleware ignores that copy and
 * re-derives the effective set from the database on every request. The cost is one indexed
 * find per request; the benefit is that revoking a permission takes effect on the user's very
 * next call instead of whenever their 15-minute token happens to expire.
 *
 * `tokenVersion` is the instant kill switch. Any change that alters what a user may do bumps
 * it, and every token issued before that bump is rejected here — which is the difference
 * between "you have been demoted" and "you have been demoted in about a quarter of an hour".
 *
 * Wrapped in `markAuthenticate` so the route-coverage test can recognise this guard once it is
 * sitting anonymously in an Express layer stack — see `guardMeta.ts`.
 */
export const authenticate: RequestHandler = markAuthenticate(
  asyncHandler(async (req, _res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw ApiError.unauthenticated('Authentication required');

    const payload = verifyAccessToken(token);

    const user = await User.findById(payload.sub);
    if (!user) throw ApiError.unauthenticated('Invalid authentication token');

    if (!user.isActive) {
      throw new ApiError(401, 'ACCOUNT_DISABLED', 'This account has been disabled');
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw new ApiError(
        401,
        'TOKEN_EXPIRED',
        'Your access has changed — please sign in again',
      );
    }

    // Tenancy comes from the verified token, never from a header or the body (§6.1).
    if (String(user.orgId) !== payload.orgId) {
      throw ApiError.unauthenticated('Invalid authentication token');
    }

    req.user = await toAuthUser(user);

    // The business's subscription (SaaS phase 4). Read-only and blocked businesses can still
    // sign in, see who they are and read their billing page — that is how they find out why.
    const access = await orgAccess(user.orgId);
    req.subscription = access;
    const path = req.originalUrl.split('?')[0] ?? '';
    const alwaysAllowed = SUBSCRIPTION_EXEMPT.some((p) => path === p || path.startsWith(`${p}/`));

    if (!alwaysAllowed && access.state.access === 'BLOCKED') {
      throw new ApiError(
        403,
        'ORG_SUSPENDED',
        access.state.status === 'CANCELLED'
          ? 'This business account has been closed'
          : 'This business account is suspended — contact support',
      );
    }
    if (!alwaysAllowed && access.state.access === 'READ_ONLY' && !SAFE_METHODS.has(req.method)) {
      throw new ApiError(
        402,
        'SUBSCRIPTION_EXPIRED',
        'Your subscription has ended, so changes are paused. Renew to continue — your data is safe and still visible.',
        { dueSince: access.state.dueSince?.toISOString() ?? null },
      );
    }

    next();
  }),
);

/**
 * Reachable whatever the subscription: the caller's own session (`/auth/*` — me, logout, password)
 * and the billing summary that explains the state they are in.
 */
const SUBSCRIPTION_EXEMPT = ['/api/v1/auth', '/api/v1/org/subscription'];

/**
 * The blanket guard mounted at `/api/v1` in app.ts, with the public mounts exempted.
 *
 * Defence in depth: `requirePermission` on each route is the real gate, and Day 3's coverage
 * test fails the build if a route lacks one. This exists so that in the window between writing
 * a route and running that test, an unguarded endpoint is still not anonymous.
 */
export function authenticateUnlessPublic(publicPaths: readonly string[]): RequestHandler {
  return (req, res, next) => {
    // `req.baseUrl` is '/api/v1' here, so compare against the full mount prefix.
    const fullPath = `${req.baseUrl}${req.path}`;
    const isPublic = publicPaths.some((p) => fullPath === p || fullPath.startsWith(`${p}/`));

    if (isPublic) {
      next();
      return;
    }
    authenticate(req, res, next);
  };
}
