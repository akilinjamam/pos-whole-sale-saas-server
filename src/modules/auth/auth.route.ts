import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { config } from '../../config/env.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { changePasswordSchema } from '../user/user.schema.js';

import {
  forgotPasswordSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from './account.schema.js';
import * as ctrl from './auth.controller.js';
import { loginSchema, refreshSchema } from './auth.schema.js';

/**
 * The only router with unauthenticated routes.
 *
 * `login` and `refresh` are on the coverage test's allow-list — they cannot require a token,
 * since obtaining one is their job. `me`, `logout` and `password` require authentication but
 * deliberately carry **no** `requirePermission`: they are about the caller's own account, and
 * a permission gate on "who am I" would lock a user out of the app that is meant to tell them
 * they have no permissions.
 */
const authRouter = Router();

/**
 * A much tighter limit than the global one. Login is the one endpoint where an attacker gets
 * unlimited free guesses, and 300/min — the global allowance — is a comfortable rate at which
 * to grind a weak password.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // within 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again shortly.' },
  },
});

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), ctrl.login);

/**
 * Self-service account flows (SaaS phase 3). Public, so each is rate-limited per IP: signup creates
 * a whole business, and forgot-password sends email to whatever address it is given.
 */
const accountLimiter = () =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.saas.authRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' },
    },
  });

authRouter.post('/signup', accountLimiter(), validate({ body: signupSchema }), ctrl.signup);
authRouter.post(
  '/verify-email',
  accountLimiter(),
  validate({ body: verifyEmailSchema }),
  ctrl.verifyEmail,
);
authRouter.post('/resend-verification', authenticate, ctrl.resendVerification);
authRouter.post(
  '/forgot-password',
  accountLimiter(),
  validate({ body: forgotPasswordSchema }),
  ctrl.forgotPassword,
);
authRouter.post(
  '/reset-password',
  accountLimiter(),
  validate({ body: resetPasswordSchema }),
  ctrl.resetPassword,
);

authRouter.post('/refresh', validate({ body: refreshSchema }), ctrl.refresh);

authRouter.post('/logout', authenticate, ctrl.logout);

authRouter.get('/me', authenticate, ctrl.me);

// Also self-service: the locations *this* caller may work in, for the topbar switcher. A
// cashier must be able to pick their till without holding `location:read`.
authRouter.get('/me/locations', authenticate, ctrl.myLocations);

authRouter.post(
  '/password',
  authenticate,
  validate({ body: changePasswordSchema }),
  ctrl.changePassword,
);

export default authRouter;
