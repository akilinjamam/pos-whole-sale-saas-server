import { createHash, randomBytes } from 'node:crypto';

import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../lib/ApiError.js';
import { withTransaction } from '../../lib/withTransaction.js';
import * as templates from '../../services/emailTemplates.js';
import { sendMail } from '../../services/mailer.service.js';
import { provisionOrg } from '../../services/provisioning.service.js';
import { Org } from '../org/org.model.js';
import { User } from '../user/user.model.js';

import { login } from './auth.service.js';
import { EmailToken } from './emailToken.model.js';

import type { EmailTokenPurpose } from './emailToken.model.js';
import type { ForgotPasswordInput, ResetPasswordInput, SignupInput } from './account.schema.js';
import type { AuthUser, LoginResponse, VerifyEmailResponse } from '@shared/types.js';
import type { Types } from 'mongoose';

/**
 * Self-service account flows — SaaS phase 3: signup, email verification, forgot / reset password.
 *
 * Tokens are 32 random bytes in the link and a SHA-256 hash in the database (`EmailToken`). Each
 * new link of a purpose replaces the user's unused ones, so only the latest email works.
 *
 * Emails are sent **after** the transaction commits — see `mailer.service.ts`.
 */

export const VERIFY_HOURS = 48;
export const RESET_MINUTES = 60;
/** A second verification email within this window is refused, so the button cannot spam. */
export const RESEND_COOLDOWN_SECONDS = 60;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidLink(): ApiError {
  return new ApiError(400, 'TOKEN_INVALID', 'This link is invalid or has expired');
}

/** Replace the user's unused tokens of this purpose with a new one; returns the plain token. */
async function issueToken(
  user: { _id: Types.ObjectId; orgId: Types.ObjectId; email: string },
  purpose: EmailTokenPurpose,
  ttlMs: number,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await EmailToken.deleteMany({ userId: user._id, purpose, usedAt: null });
  await EmailToken.create({
    orgId: user.orgId,
    userId: user._id,
    purpose,
    email: user.email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

async function sendVerification(userId: Types.ObjectId): Promise<boolean> {
  const user = await User.findById(userId).select('orgId name email emailVerifiedAt').lean();
  if (!user || user.emailVerifiedAt) return false;
  const org = await Org.findById(user.orgId).select('name').lean();
  const token = await issueToken(user, 'VERIFY_EMAIL', VERIFY_HOURS * 3_600_000);
  return sendMail(
    templates.verifyEmail({
      to: user.email,
      name: user.name,
      businessName: org?.name ?? 'your business',
      token,
      hoursValid: VERIFY_HOURS,
    }),
  );
}

/**
 * Create a business and its owner, start the trial, send the verification email, and sign the
 * owner in — one request from the signup form to a working dashboard.
 */
export async function signup(input: SignupInput): Promise<LoginResponse> {
  if (!config.saas.signupEnabled) {
    throw new ApiError(403, 'SIGNUP_DISABLED', 'New sign-ups are closed at the moment');
  }

  const created = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: input.businessName, phone: input.phone ?? null },
        owner: {
          name: input.ownerName,
          email: input.email,
          phone: input.phone ?? null,
          password: input.password,
        },
        status: 'TRIAL',
        trialDays: config.saas.trialDays,
        planCode: config.saas.trialPlanCode,
        signupSource: 'SIGNUP',
      },
      session,
    ),
  );
  logger.info({ orgId: String(created.orgId), slug: created.slug }, 'Business signed up');

  await sendVerification(created.ownerUserId);
  return login({ email: input.email, password: input.password });
}

/** `POST /auth/verify-email` — the link in the verification email lands here (via the client). */
export async function verifyEmail(token: string): Promise<VerifyEmailResponse> {
  const now = new Date();
  const record = await EmailToken.findOneAndUpdate(
    { tokenHash: hashToken(token), purpose: 'VERIFY_EMAIL', usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
  ).lean();
  if (!record) throw invalidLink();

  const user = await User.findOneAndUpdate(
    // Only the address the link was sent to; and only once, so `emailVerifiedAt` keeps the first.
    { _id: record.userId, email: record.email },
    [{ $set: { emailVerifiedAt: { $ifNull: ['$emailVerifiedAt', now] } } }],
    { new: true },
  ).lean();
  if (!user) throw invalidLink();

  return { email: user.email };
}

/** `POST /auth/resend-verification` — for the signed-in user, from the "verify your email" banner. */
export async function resendVerification(user: AuthUser): Promise<{ sent: boolean }> {
  if (user.emailVerified) return { sent: false };

  const recent = await EmailToken.exists({
    userId: user.id,
    purpose: 'VERIFY_EMAIL',
    usedAt: null,
    createdAt: { $gt: new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000) },
  });
  if (recent) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'A verification email was just sent — check your inbox, or try again in a minute',
    );
  }

  const doc = await User.findById(user.id).select('_id').lean();
  if (!doc) throw ApiError.unauthenticated();
  return { sent: await sendVerification(doc._id) };
}

/**
 * `POST /auth/forgot-password` — always answers the same, whether or not the address has an
 * account, so the form cannot be used to find out who is a customer.
 */
export async function forgotPassword(input: ForgotPasswordInput): Promise<void> {
  const user = await User.findOne({ email: input.email, isActive: true })
    .select('orgId name email')
    .lean();
  if (!user) {
    logger.info({ email: input.email }, 'Password reset asked for an unknown or inactive email');
    return;
  }

  const token = await issueToken(user, 'RESET_PASSWORD', RESET_MINUTES * 60_000);
  await sendMail(
    templates.resetPassword({ to: user.email, name: user.name, token, minutesValid: RESET_MINUTES }),
  );
}

/**
 * `POST /auth/reset-password` — claim the token and set the password in one transaction, so a link
 * works exactly once. Every existing session is ended (`tokenVersion`), and since following the
 * link proves the address, an unverified email becomes verified.
 */
export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const now = new Date();
  await withTransaction(async (session) => {
    const record = await EmailToken.findOneAndUpdate(
      {
        tokenHash: hashToken(input.token),
        purpose: 'RESET_PASSWORD',
        usedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { usedAt: now } },
      { session },
    ).lean();
    if (!record) throw invalidLink();

    const user = await User.findOne({ _id: record.userId, isActive: true })
      .select('+passwordHash')
      .session(session);
    if (!user || user.email !== record.email) throw invalidLink();

    user.passwordHash = input.password; // hashed by the pre-save hook
    user.mustChangePassword = false;
    user.emailVerifiedAt ??= now;
    user.tokenVersion += 1;
    await user.save({ session });
  });
}
