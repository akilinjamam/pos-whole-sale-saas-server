/**
 * Wholesale returns and credit notes (Day 36). Shared: the return screen validates with these.
 *
 * A wholesale return comes back against a posted invoice. Each line says what condition it came
 * back in and **where it goes**: good stock to a selling location, damaged to a damage location —
 * a person decides, the system records. It settles as:
 *
 *   - `CREDIT_NOTE` — a credit on the dealer's account (`CN-`), set against invoices: by default
 *     the invoice the goods came back from, or explicitly, or left open to spend later;
 *   - `CASH_REFUND` — money back, for goods the dealer had already paid for (`return:approve`).
 *
 * A replacement is a new order paid for by the credit note — there is no third path here.
 */

import { z } from 'zod';

import { RETURN_REASONS } from './enums.js';

import type { PaymentMethod } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const minor = z
  .number()
  .int('Whole minor units')
  .min(1, 'More than zero')
  .max(Number.MAX_SAFE_INTEGER);

export const WHOLESALE_RETURN_SETTLEMENTS = ['CREDIT_NOTE', 'CASH_REFUND'] as const;
export type WholesaleReturnSettlement = (typeof WHOLESALE_RETURN_SETTLEMENTS)[number];

export const REFUND_METHODS = [
  'CASH',
  'BANK',
  'MFS',
] as const satisfies readonly PaymentMethod[];
export type RefundMethod = (typeof REFUND_METHODS)[number];

export const wholesaleReturnLineSchema = z
  .object({
    invoiceLineId: objectId,
    /** Base units — a returned dozen is 12. */
    qtyBase: z.number().int('Whole units only').min(1, 'At least 1').max(1_000_000),
    serials: z.array(z.string().trim().toUpperCase().min(1).max(60)).max(10_000).optional(),
    condition: z.enum(['GOOD', 'DAMAGED']),
    /** Where it goes: a selling location for GOOD, a damage location for DAMAGED. */
    restockLocationId: objectId,
  })
  .strict();

export const creditAllocationInputSchema = z
  .object({ invoiceId: objectId, amountMinor: minor })
  .strict();

export const wholesaleReturnSchema = z
  .object({
    invoiceId: objectId,
    reason: z.enum(RETURN_REASONS),
    settlement: z.enum(WHOLESALE_RETURN_SETTLEMENTS),
    lines: z.array(wholesaleReturnLineSchema).min(1, 'Choose what is coming back').max(500),
    /**
     * A credit note's allocation. Omitted: against the invoice the goods came back from, as far as
     * it is still owed. Empty: none — the whole credit stays open. Otherwise exactly these.
     */
    allocations: z.array(creditAllocationInputSchema).max(200).optional(),
    /** A refund's method and reference. */
    refundMethod: z.enum(REFUND_METHODS).optional(),
    reference: z.string().trim().max(80).nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((r) => r.settlement !== 'CASH_REFUND' || !r.allocations, {
    path: ['allocations'],
    message: 'A refund is not allocated — it is paid out',
  });

/** Spend an open credit note: omitted allocations → oldest due first. */
export const allocateCreditNoteSchema = z
  .object({ allocations: z.array(creditAllocationInputSchema).min(1).max(200).optional() })
  .strict();

export type WholesaleReturnLineInput = z.infer<typeof wholesaleReturnLineSchema>;
export type WholesaleReturnInput = z.infer<typeof wholesaleReturnSchema>;
export type CreditAllocationInput = z.infer<typeof creditAllocationInputSchema>;
export type AllocateCreditNoteInput = z.infer<typeof allocateCreditNoteSchema>;
