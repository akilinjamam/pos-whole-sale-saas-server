/**
 * Report queries (Day 37). Shared: the report screens build their filters from these.
 *
 * Every report takes a period (`from`–`to`, inclusive days in the org's zone; default this month
 * to today) and a location, and returns its rows, its totals, and a **tie** — the same total
 * computed from the ledger underneath, so the screen can show that the two agree.
 */

import { z } from 'zod';

import { PAYMENT_METHODS, SALES_CHANNELS } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const day = z.string().date('Use YYYY-MM-DD');

const period = {
  from: day.optional(),
  to: day.optional(),
  locationId: objectId.optional(),
};

export const SALES_GROUPINGS = [
  'dealer',
  'product',
  'brand',
  'salesperson',
  'channel',
  'day',
  'month',
] as const;
export type SalesGrouping = (typeof SALES_GROUPINGS)[number];

export const salesReportQuerySchema = z
  .object({
    ...period,
    groupBy: z.enum(SALES_GROUPINGS).default('dealer'),
    channel: z.enum(SALES_CHANNELS).optional(),
  })
  .strict();

export const stockValuationQuerySchema = z
  .object({
    locationId: objectId.optional(),
    /** One row per item, or one per item per location. */
    groupBy: z.enum(['product', 'location']).default('product'),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

export const periodQuerySchema = z.object(period).strict();

export const collectionRegisterQuerySchema = z
  .object({ ...period, method: z.enum(PAYMENT_METHODS).optional() })
  .strict();

export const deadStockQuerySchema = z
  .object({
    locationId: objectId.optional(),
    /** Not sold in this many days (or ever). */
    days: z.coerce.number().int().min(1).max(3650).default(90),
  })
  .strict();

export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;
export type StockValuationQuery = z.infer<typeof stockValuationQuerySchema>;
export type PeriodQuery = z.infer<typeof periodQuerySchema>;
export type CollectionRegisterQuery = z.infer<typeof collectionRegisterQuerySchema>;
export type DeadStockQuery = z.infer<typeof deadStockQuerySchema>;
