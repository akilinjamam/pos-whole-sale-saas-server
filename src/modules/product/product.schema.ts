import { z } from 'zod';

import { listQuerySchema } from '../../lib/paginate.js';
import { BASE_UOMS, PACK_CODES, PRODUCT_TYPES, TRACKING_MODES } from '../../shared/enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

/** Amounts are minor units on the wire — the field names say so, so there is no ambiguity. */
const minorAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const packSchema = z
  .object({
    code: z.enum(PACK_CODES),
    name: z.string().trim().min(1).max(30),
    /**
     * Base units per pack. At least 2: a pack of one is not a pack, it is the base unit under
     * another name, and it makes `uomQty × factor` ambiguous for anyone reading an order line.
     */
    factor: z.number().int().min(2).max(100_000),
    barcode: z.string().trim().max(60).nullable().optional().default(null),
  })
  .strict();

/**
 * The fields shared by create and update.
 *
 * `attrs` is `unknown` here and validated in the service, against the caller's `type` — see
 * `parseAttrs` there. The union needs the discriminant, and making the client repeat `type`
 * inside `attrs` to satisfy a validator is an implementation detail leaking into the API.
 *
 * `avgCostMinor` is deliberately absent from both: it is derived by the costing engine on every
 * goods receipt (Day 33), and an API that lets it be set would let someone silently rewrite
 * stock valuation.
 */
const productBase = z.object({
  sku: z.string().trim().toUpperCase(),
  // .min(1)
  // .max(40)
  // .regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Letters, digits, dot, dash and underscore'),
  name: z.string().trim().min(1, 'Required').max(160),
  type: z.enum(PRODUCT_TYPES),
  brandId: objectId.nullable().optional(),
  categoryId: objectId.nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  images: z.array(z.string().trim().url()).max(10).optional(),
  barcode: z.string().trim().min(4).max(60).nullable().optional(),

  baseUom: z.enum(BASE_UOMS),
  packs: z.array(packSchema).max(4).optional(),
  trackingMode: z.enum(TRACKING_MODES).optional(),

  hasVariants: z.boolean().optional(),
  variantAxes: z.array(z.string()).max(6).optional(),

  taxRatePct: z.number().min(0).max(100).optional(),
  hsCode: z.string().trim().max(20).nullable().optional(),

  mrpMinor: minorAmount.optional(),
  defaultSellPriceMinor: minorAmount.optional(),
  standardCostMinor: minorAmount.optional(),

  reorderPoint: z.number().int().min(0).max(1_000_000).optional(),
  reorderQty: z.number().int().min(0).max(1_000_000).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),

  isActive: z.boolean().optional(),
  isSellableAtCounter: z.boolean().optional(),
  isSellableWholesale: z.boolean().optional(),

  attrs: z.unknown().optional(),
});

/**
 * Rules that span fields. Each issue names the input the user has to correct.
 *
 * Only the checks that need nothing but the body live here. Anything that depends on the
 * product's `type` is in the service instead: on an update the client may legitimately omit
 * `type`, and a check that silently skipped itself when a field was absent would be worse than
 * no check at all. See `assertVariantAxes` there.
 */
function checkCrossFields(
  value: Partial<z.infer<typeof productBase>>,
  ctx: z.RefinementCtx,
): void {
  const { packs, baseUom, hasVariants, variantAxes } = value;

  if (packs && packs.length > 0) {
    const seen = new Set<string>();
    packs.forEach((pack, index) => {
      if (seen.has(pack.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packs', index, 'code'],
          message: `Already used: a product cannot declare ${pack.code} twice`,
        });
      }
      seen.add(pack.code);

      // A DOZ pack on a DOZ base would make `uomQty × factor` self-referential, and the stock
      // engine — which only ever sees base units — would multiply the base by itself.
      if (baseUom && pack.code === baseUom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packs', index, 'code'],
          message: `${pack.code} is already the base unit`,
        });
      }
    });
  }

  if (hasVariants && (!variantAxes || variantAxes.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['variantAxes'],
      message: 'Choose at least one axis, or turn variants off',
    });
  }
}

export const createProductSchema = productBase
  .strict()
  .superRefine((value, ctx) => checkCrossFields(value, ctx));

export type CreateProductInput = z.infer<typeof createProductSchema>;

/**
 * `type` is **accepted but immutable** — sending the product's existing type is fine, changing
 * it is a 422 from the service.
 *
 * Omitting it from the schema would be the obvious way to express "immutable", and it is wrong
 * in practice: an editor loads a product, binds the whole document to a form and PATCHes all of
 * it back, so a perfectly ordinary save would fail on a field the user never touched.
 *
 * It cannot be *changed* because doing so would invalidate the product's `attrs`, its variant
 * axes and — once stock exists — the tracking mode its ledger rows were written under. A
 * mistyped type is fixed by deactivating the product and creating the right one.
 */
export const updateProductSchema = productBase
  .partial()
  .strict()
  .superRefine((value, ctx) => checkCrossFields(value, ctx));

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsQuerySchema = listQuerySchema.extend({
  type: z.enum(PRODUCT_TYPES).optional(),
  brandId: objectId.optional(),
  categoryId: objectId.optional(),
  /** The whole category subtree, at any depth — resolved through `Category.path`. */
  categoryUnder: objectId.optional(),
  trackingMode: z.enum(TRACKING_MODES).optional(),
  hasVariants: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
