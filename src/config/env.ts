/**
 * Environment configuration — validated once, at startup, and frozen.
 *
 * A missing or malformed variable kills the process here with a readable message rather than
 * surfacing as an undefined deep inside a request three days later.
 */

import 'dotenv/config';
import { z } from 'zod';

const durationPattern = /^\d+[smhd]$/;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5101),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().min(1).default('pos_wholesale_saas'),

  APP_TIMEZONE: z.string().min(1).default('Asia/Dhaka'),
  DEFAULT_CURRENCY: z.string().length(3).default('BDT'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().regex(durationPattern, 'e.g. 15m').default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_TTL: z.string().regex(durationPattern, 'e.g. 30d').default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  /**
   * Signs platform-admin tokens (SaaS phase 5) — a third secret, so a business's token can never be
   * presented to a platform route, nor the reverse. Optional in development: without it the
   * platform routes answer 503. Required in production (below).
   */
  JWT_PLATFORM_SECRET: z
    .string()
    .min(32, 'JWT_PLATFORM_SECRET must be at least 32 characters')
    .optional(),
  /** Platform sessions do not refresh; an admin signs in again after this. */
  JWT_PLATFORM_TTL: z.string().regex(durationPattern, 'e.g. 8h').default('8h'),

  CORS_ORIGINS: z.string().default('http://localhost:5175'),
  /**
   * SameSite on the refresh-token cookie. `lax` only works when client and API share a site
   * (app.example.com + api.example.com). When they don't — a Netlify client calling an
   * onrender.com API — the browser never sends a `lax` cookie to `/auth/refresh`, the refresh
   * fails, and every user is logged out the moment their 15-minute access token expires.
   * `none` fixes that (and forces `Secure`), but Safari blocks such third-party cookies anyway;
   * a shared domain is the real fix.
   */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Per business, across all its addresses, per window (SaaS phase 7). */
  ORG_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1200),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('debug'),
  /**
   * Put the full header block back into the HTTP log — the one thing the trimmed serializers
   * in app.ts drop. Its own flag rather than a LOG_LEVEL check, because LOG_LEVEL is already
   * `debug` in development, so gating on the level would mean "always on" exactly where the
   * noise is the problem. Turn it on for an afternoon of debugging CORS or auth, then off.
   */
  LOG_HTTP_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ─── SaaS: signup and email (phase 3) ───
  /** Where the web client lives — the base of every link in an email. No trailing slash. */
  APP_PUBLIC_URL: z
    .string()
    .url()
    .default('http://localhost:5175')
    .transform((v) => v.replace(/\/+$/, '')),
  /** `false` closes public signup; businesses can then only be created by a platform admin. */
  SIGNUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(14),
  /** The plan a new signup trials (SaaS phase 4) — its limits and features apply during the trial. */
  TRIAL_PLAN_CODE: z.string().trim().toUpperCase().default('BUSINESS'),
  /** Days after a trial / paid period ends before the business becomes read-only. */
  GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  /** Days a closed business's data is kept before `scripts/purge-org.ts` may delete it (phase 7). */
  PURGE_AFTER_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  /** How to pay, shown on the billing page — e.g. "bKash 01XXXXXXXXX (merchant), reference: your business name". */
  BILLING_INSTRUCTIONS: z.string().trim().optional(),
  /** Per IP, per 15 minutes, for each of signup / forgot-password / reset / verify. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /**
   * SMTP. With no SMTP_HOST, emails are written to the log instead of sent — which is what
   * development wants, and refused in production (below), where a silent signup is a lost customer.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  /** `true` for port 465 (implicit TLS); `false` for 587, which upgrades with STARTTLS. */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(3).default('Optical Wholesale <no-reply@localhost>'),

  UPLOAD_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),

  /**
   * Create one demo account per system role (storekeeper@…, accounts@…, and so on) so the
   * difference between the roles can actually be *seen* — which is the whole point of Day 4's
   * "three roles, three different menus". Refused outright in production below: a known
   * password on a role that can post stock is not something to leave to a flag.
   */
  SEED_DEMO_USERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SEED_DEMO_PASSWORD: z.string().min(8).default('Demo1234!'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
  // Deliberately console, not the logger — the logger depends on this module.
  console.error(`\nInvalid environment configuration:\n${lines.join('\n')}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
}

const raw = parsed.data;

if (raw.NODE_ENV === 'production' && !raw.JWT_PLATFORM_SECRET) {
  console.error('\nJWT_PLATFORM_SECRET is required in production — it signs platform-admin sessions.\n');
  process.exit(1);
}
if (
  raw.JWT_PLATFORM_SECRET &&
  [raw.JWT_ACCESS_SECRET, raw.JWT_REFRESH_SECRET].includes(raw.JWT_PLATFORM_SECRET)
) {
  console.error('\nJWT_PLATFORM_SECRET must differ from the access and refresh secrets.\n');
  process.exit(1);
}

if (raw.NODE_ENV === 'production' && !raw.SMTP_HOST) {
  console.error('\nSMTP_HOST is required in production — signup and password reset send email.\n');
  process.exit(1);
}

export const config = Object.freeze({
  env: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,

  db: {
    uri: raw.MONGODB_URI,
    name: raw.MONGODB_DB_NAME,
  },

  locale: {
    timezone: raw.APP_TIMEZONE,
    currency: raw.DEFAULT_CURRENCY,
  },

  jwt: {
    accessSecret: raw.JWT_ACCESS_SECRET,
    accessTtl: raw.JWT_ACCESS_TTL,
    refreshSecret: raw.JWT_REFRESH_SECRET,
    refreshTtl: raw.JWT_REFRESH_TTL,
    platformSecret: raw.JWT_PLATFORM_SECRET ?? null,
    platformTtl: raw.JWT_PLATFORM_TTL,
  },

  bcryptRounds: raw.BCRYPT_ROUNDS,

  http: {
    corsOrigins: raw.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    cookieSameSite: raw.COOKIE_SAMESITE,
    rateLimitWindowMs: raw.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: raw.RATE_LIMIT_MAX,
    orgRateLimitMax: raw.ORG_RATE_LIMIT_MAX,
  },

  logLevel: raw.LOG_LEVEL,
  logHttpHeaders: raw.LOG_HTTP_HEADERS,

  saas: {
    publicUrl: raw.APP_PUBLIC_URL,
    signupEnabled: raw.SIGNUP_ENABLED,
    trialDays: raw.TRIAL_DAYS,
    trialPlanCode: raw.TRIAL_PLAN_CODE,
    graceDays: raw.GRACE_DAYS,
    purgeAfterDays: raw.PURGE_AFTER_DAYS,
    billingInstructions: raw.BILLING_INSTRUCTIONS || null,
    authRateLimitMax: raw.AUTH_RATE_LIMIT_MAX,
  },

  mail: {
    host: raw.SMTP_HOST ?? null,
    port: raw.SMTP_PORT,
    secure: raw.SMTP_SECURE,
    user: raw.SMTP_USER ?? null,
    pass: raw.SMTP_PASS ?? null,
    from: raw.MAIL_FROM,
  },

  uploads: {
    driver: raw.UPLOAD_DRIVER,
    dir: raw.UPLOAD_DIR,
  },

  seed: {
    adminEmail: raw.SEED_ADMIN_EMAIL ?? null,
    adminPassword: raw.SEED_ADMIN_PASSWORD ?? null,
    // The `&&` is the guard, not the flag: demo accounts share one published password, so
    // production must not be able to grow them by setting an environment variable.
    demoUsers: raw.SEED_DEMO_USERS && raw.NODE_ENV !== 'production',
    demoPassword: raw.SEED_DEMO_PASSWORD,
  },
});

export type Config = typeof config;
