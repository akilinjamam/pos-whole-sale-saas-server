import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import {
  forgotPassword,
  resendVerification,
  resetPassword,
  signup,
  verifyEmail,
} from '../../src/modules/auth/account.service.js';
import { login, me, refresh } from '../../src/modules/auth/auth.service.js';
import { EmailToken } from '../../src/modules/auth/emailToken.model.js';
import { Org } from '../../src/modules/org/org.model.js';
import { dismissOnboarding, getOnboarding, updateOrg } from '../../src/modules/org/org.service.js';
import { createUser } from '../../src/modules/user/user.service.js';
import { outbox } from '../../src/services/mailer.service.js';

import { cleanupOrg } from './fixtures/posFixture.js';

import type { RequestActor } from '../../src/lib/requestUser.js';
import type { AuthUser, LoginResponse } from '@shared/types.js';

/**
 * SaaS phase 3's "done when", against a real replica set: signup → email link → verified, and
 * forgot → reset → signed in with the new password. Email goes to the in-memory `outbox`
 * (SMTP_HOST is empty in vitest.integration.config.ts), which is where the links are read from.
 */

const run = randomUUID().slice(0, 8);
const email = `zztest-signup-${run}@example.invalid`;
const PASSWORD = 'Signup123!';
const NEW_PASSWORD = 'Changed456!';

let session: LoginResponse;
let orgId: Types.ObjectId;

function actorOf(user: AuthUser): RequestActor {
  return {
    orgId: new Types.ObjectId(user.orgId),
    actorId: new Types.ObjectId(user.id),
    user,
  };
}

/** The token in the newest email to `to`, from the link `…/<path>?token=…`. */
function tokenFromOutbox(to: string, path: string): string {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes(path));
  expect(mail, `no email to ${to} containing ${path}`).toBeTruthy();
  const match = new RegExp(`${path}\\?token=([A-Za-z0-9_%-]+)`).exec(mail!.text);
  return decodeURIComponent(match![1]!);
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  if (orgId) await cleanupOrg(orgId);
  await disconnectDatabase();
});

describe('signup', () => {
  it('creates a business on trial, signs the owner in, and sends a verification email', async () => {
    session = await signup({
      businessName: `ZZTEST Signup Optical ${run}`,
      ownerName: 'Signup Owner',
      email: email.toUpperCase(),
      phone: '01700000000',
      password: PASSWORD,
    });
    orgId = new Types.ObjectId(session.user.orgId);

    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.user.email).toBe(email);
    expect(session.user.roleCodes).toEqual(['OWNER']);
    expect(session.user.emailVerified).toBe(false);

    const org = await Org.findById(orgId).lean();
    expect(org?.status).toBe('TRIAL');
    expect(org?.signupSource).toBe('SIGNUP');
    expect(org?.trialEndsAt).toBeInstanceOf(Date);
    expect(org!.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    expect(tokenFromOutbox(email, '/verify-email')).toHaveLength(43);
  });

  it('stores only a hash of the token', async () => {
    const token = tokenFromOutbox(email, '/verify-email');
    const stored = await EmailToken.findOne({ orgId, purpose: 'VERIFY_EMAIL' }).lean();
    expect(stored?.tokenHash).toBeTruthy();
    expect(stored?.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('refuses a second business for the same email', async () => {
    const err = await refusal(
      signup({ businessName: 'ZZTEST Again', ownerName: 'X', email, password: PASSWORD }),
    );
    expect(err.code).toBe('EMAIL_TAKEN');
  });

  it('does not let an unverified owner add users', async () => {
    const err = await refusal(
      createUser(
        orgId,
        {
          name: 'Staff',
          email: `zztest-staff-${run}@example.invalid`,
          password: PASSWORD,
          roleIds: [session.user.roleIds[0]!],
          permissionGrants: [],
          permissionRevokes: [],
          locationIds: [],
        },
        new Types.ObjectId(session.user.id),
      ),
    );
    expect(err.status).toBe(403);
    expect(err.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('throttles the resend button', async () => {
    const err = await refusal(resendVerification(session.user));
    expect(err.status).toBe(429);
  });
});

describe('email verification', () => {
  it('verifies with the link, once', async () => {
    const token = tokenFromOutbox(email, '/verify-email');
    expect(await verifyEmail(token)).toEqual({ email });

    const user = await me(new Types.ObjectId(session.user.id));
    expect(user.emailVerified).toBe(true);

    expect((await refusal(verifyEmail(token))).code).toBe('TOKEN_INVALID');
  });

  it('refuses an unknown token', async () => {
    expect((await refusal(verifyEmail('x'.repeat(43)))).code).toBe('TOKEN_INVALID');
  });

  it('lets the verified owner add users', async () => {
    const owner = await me(new Types.ObjectId(session.user.id));
    const staff = await createUser(
      orgId,
      {
        name: 'Staff',
        email: `zztest-staff-${run}@example.invalid`,
        password: PASSWORD,
        roleIds: [owner.roleIds[0]!],
        permissionGrants: [],
        permissionRevokes: [],
        locationIds: [],
      },
      new Types.ObjectId(owner.id),
    );
    expect(staff.email).toBe(`zztest-staff-${run}@example.invalid`);
  });

  it('has nothing to resend once verified', async () => {
    const owner = await me(new Types.ObjectId(session.user.id));
    expect(await resendVerification(owner)).toEqual({ sent: false });
  });
});

describe('forgot and reset password', () => {
  it('says nothing, and sends nothing, for an unknown address', async () => {
    const before = outbox.length;
    await expect(forgotPassword({ email: `zztest-nobody-${run}@example.invalid` })).resolves.toBeUndefined();
    expect(outbox.length).toBe(before);
  });

  it('resets with the emailed link, ends old sessions, and works once', async () => {
    await forgotPassword({ email });
    const token = tokenFromOutbox(email, '/reset-password');

    await resetPassword({ token, password: NEW_PASSWORD });

    expect((await refusal(login({ email, password: PASSWORD }))).code).toBe('INVALID_CREDENTIALS');
    const fresh = await login({ email, password: NEW_PASSWORD });
    expect(fresh.user.id).toBe(session.user.id);

    // The refresh token from signup belongs to a session the reset ended.
    expect((await refusal(refresh(session.refreshToken))).status).toBe(401);
    // And the link is spent.
    expect((await refusal(resetPassword({ token, password: 'Another789!' }))).code).toBe(
      'TOKEN_INVALID',
    );
  });

  it('only the newest link works', async () => {
    await forgotPassword({ email });
    const first = tokenFromOutbox(email, '/reset-password');
    await forgotPassword({ email });
    const second = tokenFromOutbox(email, '/reset-password');
    expect(second).not.toBe(first);

    expect((await refusal(resetPassword({ token: first, password: 'Another789!' }))).code).toBe(
      'TOKEN_INVALID',
    );
    await resetPassword({ token: second, password: 'Another789!' });
  });

  it('refuses an expired link', async () => {
    await forgotPassword({ email });
    const token = tokenFromOutbox(email, '/reset-password');
    await EmailToken.updateMany(
      { orgId, purpose: 'RESET_PASSWORD', usedAt: null },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await refusal(resetPassword({ token, password: 'Another789!' }))).code).toBe(
      'TOKEN_INVALID',
    );
  });
});

describe('onboarding checklist', () => {
  it('ticks steps from the data, and stays dismissed', async () => {
    const owner = await me(new Types.ObjectId(session.user.id));
    const actor = actorOf(owner);

    const first = await getOnboarding(actor);
    const done = (key: string, o = first) => o.steps.find((s) => s.key === key)?.done;
    expect(first.total).toBe(5);
    expect(done('VERIFY_EMAIL')).toBe(true);
    expect(done('COMPANY_DETAILS')).toBe(false);
    expect(done('FIRST_PRODUCT')).toBe(false);
    expect(done('INVITE_USER')).toBe(true); // the staff user added above
    expect(first.dismissed).toBe(false);

    await updateOrg(actor, { phone: '01711111111', address: 'Dhaka' });
    const second = await getOnboarding(actor);
    expect(done('COMPANY_DETAILS', second)).toBe(true);
    expect(second.completed).toBe(first.completed + 1);

    expect((await dismissOnboarding(actor)).dismissed).toBe(true);
    expect((await getOnboarding(actor)).dismissed).toBe(true);
  });
});
