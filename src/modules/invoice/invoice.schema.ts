import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { PAYMENT_STATUSES, SALES_CHANNELS } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const listInvoicesQuerySchema = listQuerySchema.extend({
  orderId: objectId.optional(),
  dispatchId: objectId.optional(),
  partyId: objectId.optional(),
  channel: z.enum(SALES_CHANNELS).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  /** Only invoices with something still owed. */
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Invoice date, inclusive, `YYYY-MM-DD` in the org's zone. */
  from: z.string().date('Use YYYY-MM-DD').optional(),
  to: z.string().date('Use YYYY-MM-DD').optional(),
});

export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
