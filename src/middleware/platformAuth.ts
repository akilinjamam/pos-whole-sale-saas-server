import { ApiError } from '../lib/ApiError.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { verifyPlatformToken } from '../lib/platformTokens.js';
import { extractBearerToken } from '../lib/tokens.js';
import { PlatformAdmin } from '../modules/platform/platformAdmin.model.js';

import { markPlatformAuthenticate, markPlatformPermissions } from './guardMeta.js';

import type { PlatformPermission } from '@shared/platform.js';
import type { RequestHandler } from 'express';

/**
 * The platform guards (SaaS phase 5) — the platform's own `authenticate` / `requirePermission`.
 *
 * As with tenants, the token proves identity only: the admin is re-read on every request, so
 * disabling one or changing their permissions takes effect on their next call.
 */
export const authenticatePlatform: RequestHandler = markPlatformAuthenticate(
  asyncHandler(async (req, _res, next) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw ApiError.unauthenticated('Authentication required');

    const payload = verifyPlatformToken(token);
    const admin = await PlatformAdmin.findById(payload.sub).lean();
    if (!admin || !admin.isActive) throw ApiError.unauthenticated('Invalid platform token');
    if (admin.tokenVersion !== payload.tokenVersion) {
      throw new ApiError(
        401,
        'TOKEN_EXPIRED',
        'Your access has changed — please sign in again',
      );
    }

    req.platformAdmin = admin;
    next();
  }),
);

/** All of the listed permissions, as `requirePermission` does for tenants. */
export function requirePlatformPermission(
  ...needed: [PlatformPermission, ...PlatformPermission[]]
): RequestHandler {
  const guard: RequestHandler = (req, _res, next) => {
    const admin = req.platformAdmin;
    if (!admin) {
      next(ApiError.unauthenticated());
      return;
    }
    const missing = needed.filter((p) => !admin.permissions.includes(p));
    if (missing.length > 0) {
      next(
        new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that', {
          required: needed,
          missing,
        }),
      );
      return;
    }
    next();
  };
  return markPlatformPermissions(guard, needed);
}
