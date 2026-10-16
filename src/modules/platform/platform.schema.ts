import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { LIMITED_RESOURCES, ORG_STATUSES, PLAN_FEATURES } from '../../shared/enums.js';
import { PLATFORM_PERMISSIONS, SUBSCRIPTION_PAYMENT_METHODS } from '../../shared/platform.js';
import { password } from '../user/user.schema.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const reason = z.string().trim().min(3, 'Say why').max(300);
/** Minor units, from the client as an integer — the platform screens send poisha, like the rest. */
const minor = z.number().int().min(0).max(1_000_000_000_00);

export const idParamSchema = z.object({ id: objectId });
export const codeParamSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(20),
});

// ─── Auth ───────────────────────────────────────────────────────────────────────────────

export const platformLoginSchema = z
  .object({ email, password: z.string().min(1, 'Required') })
  .strict();
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;

export const platformPasswordSchema = z
  .object({ currentPassword: z.string().min(1, 'Required'), newPassword: password })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'The new password must be different',
  });
export type PlatformPasswordInput = z.infer<typeof platformPasswordSchema>;

// ─── Businesses ─────────────────────────────────────────────────────────────────────────

export const listTenantsQuerySchema = listQuerySchema.extend({
  /** The *effective* status — a trial past its end date is PAST_DUE here. */
  status: z.enum(ORG_STATUSES).optional(),
  planCode: z.string().trim().toUpperCase().optional(),
  readOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;

export const createTenantSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(1).max(120),
    ownerEmail: email,
    ownerPhone: z.string().trim().max(40).nullable().optional(),
    /** A temporary password the admin passes on; the owner must change it at first sign-in. */
    password,
    planCode: z.string().trim().toUpperCase().min(2).max(20),
    /** TRIAL for `trialDays`, or ACTIVE with no end date until the first payment is recorded. */
    status: z.enum(['TRIAL', 'ACTIVE']),
    trialDays: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .refine((v) => v.status !== 'TRIAL' || v.trialDays !== undefined, {
    path: ['trialDays'],
    message: 'Required for a trial',
  });
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const reasonSchema = z.object({ reason }).strict();
export type ReasonInput = z.infer<typeof reasonSchema>;

export const changePlanSchema = z
  .object({ planCode: z.string().trim().toUpperCase().min(2).max(20) })
  .strict();
export type ChangePlanInput = z.infer<typeof changePlanSchema>;

export const extendTrialSchema = z.object({ days: z.number().int().min(1).max(90) }).strict();
export type ExtendTrialInput = z.infer<typeof extendTrialSchema>;

// ─── Payments ───────────────────────────────────────────────────────────────────────────

export const recordPaymentSchema = z
  .object({
    amountMinor: minor.refine((v) => v > 0, 'Must be more than zero'),
    method: z.enum(SUBSCRIPTION_PAYMENT_METHODS),
    trxId: z.string().trim().min(3).max(60).nullable().optional(),
    months: z.number().int().min(1).max(36),
    /** Switch plan with this payment; omitted keeps the current one. */
    planCode: z.string().trim().toUpperCase().min(2).max(20).optional(),
    /** ISO-8601; defaults to now. Cannot be in the future. */
    paidAt: z.coerce.date().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => v.method === 'CASH' || v.method === 'OTHER' || Boolean(v.trxId), {
    path: ['trxId'],
    message: 'Enter the transaction id or bank reference',
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const listPaymentsQuerySchema = listQuerySchema.extend({ orgId: objectId.optional() });
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

// ─── Plans ──────────────────────────────────────────────────────────────────────────────

const limits = z.object(
  Object.fromEntries(
    LIMITED_RESOURCES.map((r) => [r, z.number().int().min(1).max(1_000_000).nullable()]),
  ) as Record<(typeof LIMITED_RESOURCES)[number], z.ZodNullable<z.ZodNumber>>,
);

const planShape = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  priceMonthlyMinor: minor,
  priceYearlyMinor: minor,
  limits,
  features: z.array(z.enum(PLAN_FEATURES)).transform((v) => [...new Set(v)]),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
};

export const createPlanSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'A–Z, 0–9, _'),
    ...planShape,
  })
  .strict();
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = z.object(planShape).partial().strict();
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

// ─── Admins ─────────────────────────────────────────────────────────────────────────────

const permissions = z
  .array(z.enum(PLATFORM_PERMISSIONS))
  .min(1, 'Give at least one permission')
  .transform((v) => [...new Set(v)]);

export const createAdminSchema = z
  .object({ name: z.string().trim().min(1).max(120), email, password, permissions })
  .strict();
export type CreateAdminInput = z.infer<typeof createAdminSchema>;

export const updateAdminSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    permissions: permissions.optional(),
    isActive: z.boolean().optional(),
    /** Resets the password; the admin must change it at next sign-in. */
    password: password.optional(),
  })
  .strict();
export type UpdateAdminInput = z.infer<typeof updateAdminSchema>;
