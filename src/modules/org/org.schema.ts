import { z } from 'zod';

import { BILLING_CYCLES } from '../../shared/enums.js';

/**
 * Validation for the company profile.
 *
 * `.strict()` everywhere: an unknown key is a 422, not a silent no-op. The alternative — Zod's
 * default of stripping unknown keys — means a client that misspells `invoiceOnDispatch` gets a
 * cheerful 200 and no change, and someone spends an afternoon on it.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    legalName: z.string().trim().max(160).nullable().optional(),
    bin: z.string().trim().max(40).nullable().optional(),
    vatRegNo: z.string().trim().max(40).nullable().optional(),
    tin: z.string().trim().max(40).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().email().nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    logoUrl: z.string().trim().url().nullable().optional(),
    invoiceHeaderNote: z.string().trim().max(200).nullable().optional(),
    invoiceFooter: z.string().trim().max(1000).nullable().optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    timeZone: z.string().trim().min(1).max(60).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

/**
 * The business-rule flags. Each one changes behaviour at a specific decision point, so they
 * are edited on their own endpoint rather than buried in a profile PATCH — the audit trail
 * reads "changed allowNegativeStock", not "updated company".
 */
export const updateOrgSettingsSchema = z
  .object({
    invoiceOnDispatch: z.boolean().optional(),
    allowNegativeStock: z.boolean().optional(),
    enforceCreditLimit: z.boolean().optional(),
    defaultRetailTierId: objectId.nullable().optional(),
    /** Minor units: 0 = none, 100 = round to whole taka. */
    roundInvoiceTo: z.number().int().min(0).max(10_000).optional(),
    defaultPaymentTermsDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;

/** `POST /org/subscription/plan-request` — which plan, how often they mean to pay, and a note. */
export const planRequestSchema = z
  .object({
    planCode: z.string().trim().toUpperCase().min(2).max(20),
    cycle: z.enum(BILLING_CYCLES),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type PlanRequestInput = z.infer<typeof planRequestSchema>;

/** `POST /org/close` — the business name typed out, the owner's password, and why (optional). */
export const closeOrgSchema = z
  .object({
    businessName: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(200),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type CloseOrgInput = z.infer<typeof closeOrgSchema>;
