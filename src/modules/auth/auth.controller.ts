import { config } from '../../config/env.js';
import { ApiError } from '../../lib/ApiError.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, requireAuth } from '../../lib/requestUser.js';
import { ttlToSeconds } from '../../lib/tokens.js';
import { sendData, sendNoContent } from '../../lib/respond.js';

import * as accountService from './account.service.js';
import * as authService from './auth.service.js';

import type {
  ForgotPasswordInput,
  ResetPasswordInput,
  SignupInput,
  VerifyEmailInput,
} from './account.schema.js';
import type { LoginInput, RefreshInput } from './auth.schema.js';
import type { ChangePasswordInput } from '../user/user.schema.js';
import type { Response } from 'express';

const REFRESH_COOKIE = 'refreshToken';

/**
 * The refresh token also goes out as an httpOnly cookie.
 *
 * The response body carries it too, because the POS counter terminal keeps its tokens in
 * memory rather than relying on cookies. The cookie is the better channel where it works —
 * httpOnly puts the long-lived credential out of reach of any XSS on the page — so both are
 * offered and the client picks.
 */
/**
 * Shared by set and clear: a browser only overwrites a cookie whose attributes match, and it
 * rejects `SameSite=None` without `Secure` outright — so `none` forces `Secure` even when
 * NODE_ENV was left unset on the host.
 */
const cookieOptions = {
  httpOnly: true,
  secure: config.isProduction || config.http.cookieSameSite === 'none',
  sameSite: config.http.cookieSameSite,
  path: '/api/v1/auth',
} as const;

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...cookieOptions,
    maxAge: ttlToSeconds(config.jwt.refreshTtl) * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
}

export const login = asyncHandler(async (req, res) => {
  const input = req.body as LoginInput;
  const result = await authService.login(input);

  setRefreshCookie(res, result.refreshToken);
  sendData(res, result);
});

export const refresh = asyncHandler(async (req, res) => {
  const body = req.body as RefreshInput;
  const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
  const token = body.refreshToken ?? cookies[REFRESH_COOKIE];

  if (!token) throw ApiError.unauthenticated('No refresh token supplied');

  const tokens = await authService.refresh(token);
  setRefreshCookie(res, tokens.refreshToken);
  sendData(res, tokens);
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(actorIdOf(req));
  clearRefreshCookie(res);
  sendNoContent(res);
});

export const me = asyncHandler(async (req, res) => {
  // Served from the freshly re-derived `req.user` that `authenticate` just built, so this is
  // always current — it is how the client picks up a role change without logging out.
  sendData(res, requireAuth(req));
});

/** The caller's own accessible locations — the topbar switcher. See the service for why. */
export const myLocations = asyncHandler(async (req, res) => {
  sendData(res, await authService.myLocations(requireAuth(req)));
});

export const changePassword = asyncHandler(async (req, res) => {
  const input = req.body as ChangePasswordInput;
  const tokens = await authService.changeOwnPassword(actorIdOf(req), input);

  setRefreshCookie(res, tokens.refreshToken);
  sendData(res, tokens);
});

// ─── Self-service account flows (SaaS phase 3) ──────────────────────────────────────────

/** Signs the new owner straight in, exactly as `login` does. */
export const signup = asyncHandler(async (req, res) => {
  const result = await accountService.signup(req.body as SignupInput);
  setRefreshCookie(res, result.refreshToken);
  sendData(res, result, 201);
});

export const verifyEmail = asyncHandler(async (req, res) => {
  sendData(res, await accountService.verifyEmail((req.body as VerifyEmailInput).token));
});

export const resendVerification = asyncHandler(async (req, res) => {
  sendData(res, await accountService.resendVerification(requireAuth(req)));
});

/** 204 whether or not the address has an account — see the service. */
export const forgotPassword = asyncHandler(async (req, res) => {
  await accountService.forgotPassword(req.body as ForgotPasswordInput);
  sendNoContent(res);
});

export const resetPassword = asyncHandler(async (req, res) => {
  await accountService.resetPassword(req.body as ResetPasswordInput);
  sendNoContent(res);
});
