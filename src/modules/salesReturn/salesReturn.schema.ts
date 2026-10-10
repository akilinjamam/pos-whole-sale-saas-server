import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { SALES_CHANNELS } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const idParamSchema = z.object({ id: objectId });

export const listSalesReturnsQuerySchema = listQuerySchema.extend({
  channel: z.enum(SALES_CHANNELS).optional(),
  partyId: objectId.optional(),
  invoiceId: objectId.optional(),
});
export type ListSalesReturnsQuery = z.infer<typeof listSalesReturnsQuerySchema>;

export const listCreditNotesQuerySchema = listQuerySchema.extend({
  channel: z.enum(SALES_CHANNELS).optional(),
  partyId: objectId.optional(),
  /** Only notes with credit still to spend. */
  unallocated: flag,
});
export type ListCreditNotesQuery = z.infer<typeof listCreditNotesQuerySchema>;

export { allocateCreditNoteSchema, wholesaleReturnSchema } from '../../shared/returns.js';
