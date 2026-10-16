import jwt from 'jsonwebtoken';

import { config } from '../config/env.js';

import { ApiError } from './ApiError.js';
import { ttlToSeconds } from './tokens.js';

import type { SignOptions } from 'jsonwebtoken';

/**
 * Platform-admin tokens (SaaS phase 5): a separate secret **and** audience from the tenant tokens,
 * so neither can stand in for the other even if one secret were reused by mistake. No refresh
 * token — an admin signs in again after `JWT_PLATFORM_TTL`.
 */

const AUDIENCE = 'platform';

export interface PlatformJwtPayload {
  sub: string;
  tokenVersion: number;
}

function secret(): string {
  if (!config.jwt.platformSecret) {
    throw new ApiError(
      503,
      'INTERNAL_ERROR',
      'Platform administration is not configured on this server (JWT_PLATFORM_SECRET)',
    );
  }
  return config.jwt.platformSecret;
}

export function signPlatformToken(adminId: string, tokenVersion: number) {
  const payload: PlatformJwtPayload = { sub: adminId, tokenVersion };
  return {
    accessToken: jwt.sign(payload, secret(), {
      expiresIn: config.jwt.platformTtl,
      audience: AUDIENCE,
    } as SignOptions),
    expiresIn: ttlToSeconds(config.jwt.platformTtl),
  };
}

export function verifyPlatformToken(token: string): PlatformJwtPayload {
  try {
    return jwt.verify(token, secret(), { audience: AUDIENCE }) as PlatformJwtPayload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new ApiError(
        401,
        'TOKEN_EXPIRED',
        'Your platform session has expired — sign in again',
      );
    }
    throw ApiError.unauthenticated('Invalid platform token');
  }
}
