import { Schema, model } from 'mongoose';

import {
  BASE_UOMS,
  PACK_CODES,
  PRODUCT_TYPES,
  TRACKING_MODES,
  VARIANT_AXES,
} from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { ProductAttrs } from '@shared/catalog.js';
import type {
  BaseUom,
  PackCode,
  ProductType,
  TrackingMode,
  VariantAxis,
} from '@shared/enums.js';
import type { ProductPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A sellable article — frame, sunglass, lens, accessory or machine.
 *
 * One collection for all five types, with the type-specific fields in `attrs` and validated by
 * the zod union in `@shared/catalog`. §6.4 of the project plan argues the case; the short
 * version is that five collections means every stock, pricing and report query is written five
 * times, and a frame stops being comparable with a lens.
 *
 * Three things this model does **not** hold, on purpose:
 *
 *  - **Stock.** Quantities live in `StockBalance` per location (Day 13). A quantity on the
 *    product is the retail system's mistake: it has no location, so it answers no useful
 *    question and drifts from the ledger within a week.
 *  - **Prices per dealer.** Only the fallback `defaultSellPriceMinor` is here; tiers and
 *    dealer-specific rates are `PriceListEntry` (Day 11).
 *  - **Variants.** A lens spanning 600 powers would be 600 rows; `Variant` is materialised
 *    lazily (Day 7) and `attrs.grid` declares what is legal in the meantime.
 */
export interface ProductPackDoc {
  code: PackCode;
  name: string;
  factor: number;
  barcode: string | null;
}

export interface ProductDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  sku: string;
  name: string;
  type: ProductType;
  brandId: Types.ObjectId | null;
  categoryId: Types.ObjectId | null;
  description: string | null;
  images: string[];
  barcode: string | null;

  baseUom: BaseUom;
  packs: ProductPackDoc[];
  trackingMode: TrackingMode;

  hasVariants: boolean;
  variantAxes: VariantAxis[];

  taxRatePct: number;
  hsCode: string | null;

  mrpMinor: number;
  defaultSellPriceMinor: number;
  standardCostMinor: number;
  /** Maintained by the costing engine on every goods receipt (Day 33). Never set by the API. */
  avgCostMinor: number;

  reorderPoint: number;
  reorderQty: number;
  leadTimeDays: number;

  isActive: boolean;
  isSellableAtCounter: boolean;
  isSellableWholesale: boolean;

  attrs: ProductAttrs;

  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const packSchema = new Schema<ProductPackDoc>(
  {
    code: { type: String, required: true, enum: PACK_CODES },
    name: { type: String, required: true, trim: true },
    factor: { type: Number, required: true, min: 2 },
    barcode: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const productSchema = new Schema<ProductDoc>({
  ...auditableFields,
  sku: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: PRODUCT_TYPES },
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', default: null },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  description: { type: String, trim: true, default: null },
  images: { type: [String], default: [] },
  barcode: { type: String, trim: true, default: null },

  baseUom: { type: String, required: true, enum: BASE_UOMS },
  packs: { type: [packSchema], default: [] },
  trackingMode: { type: String, required: true, enum: TRACKING_MODES, default: 'NONE' },

  hasVariants: { type: Boolean, default: false },
  variantAxes: { type: [String], enum: VARIANT_AXES, default: [] },

  taxRatePct: { type: Number, default: 0, min: 0, max: 100 },
  hsCode: { type: String, trim: true, default: null },

  mrpMinor: { type: Number, default: 0, min: 0 },
  defaultSellPriceMinor: { type: Number, default: 0, min: 0 },
  standardCostMinor: { type: Number, default: 0, min: 0 },
  avgCostMinor: { type: Number, default: 0, min: 0 },

  reorderPoint: { type: Number, default: 0, min: 0 },
  reorderQty: { type: Number, default: 0, min: 0 },
  leadTimeDays: { type: Number, default: 0, min: 0 },

  isActive: { type: Boolean, default: true },
  isSellableAtCounter: { type: Boolean, default: true },
  isSellableWholesale: { type: Boolean, default: true },

  // `Mixed`, because the shape depends on `type` and mongoose cannot express that. The zod
  // union in `@shared/catalog` is the validator, applied at the boundary — so nothing reaches
  // here unvalidated, and mongoose is left to do what it is good at: storage.
  attrs: { type: Schema.Types.Mixed, required: true, default: {} },
});

productSchema.plugin(baseSchemaPlugin);

productSchema.index({ orgId: 1, sku: 1 }, { unique: true });

/**
 * Barcodes are unique per org, but only where one exists.
 *
 * A plain unique index would treat every barcode-less product's `null` as a value and reject
 * the second one. The partial filter restricts the constraint to documents that actually carry
 * a string, which is the only place uniqueness means anything.
 */
productSchema.index(
  { orgId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);

// The list screen's three filters, each with `orgId` leading so the index is usable under the
// tenant scope that every query carries.
productSchema.index({ orgId: 1, type: 1, isActive: 1 });
productSchema.index({ orgId: 1, brandId: 1 });
productSchema.index({ orgId: 1, categoryId: 1 });

export type ProductDocument = HydratedDocument<ProductDoc>;
export type ProductModel = Model<ProductDoc>;

// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every product.
productSchema.index({ orgId: 1, name: 1 });

export const Product: ProductModel = model<ProductDoc>('Product', productSchema);

export interface ProductPayloadOptions {
  /**
   * Whether the caller holds `stock:viewCost`. False **omits** the cost fields rather than
   * nulling them — see the note on `ProductPayload`. Stripping here, in the one serializer
   * every read goes through, is what makes the rule impossible to forget on a new endpoint.
   */
  includeCost: boolean;
  brandName?: string | null;
  categoryName?: string | null;
}

export function toProductPayload(
  doc: ProductDoc,
  options: ProductPayloadOptions,
): ProductPayload {
  const { includeCost, brandName, categoryName } = options;

  return {
    id: String(doc._id),
    sku: doc.sku,
    name: doc.name,
    type: doc.type,
    brandId: doc.brandId ? String(doc.brandId) : null,
    categoryId: doc.categoryId ? String(doc.categoryId) : null,
    description: doc.description,
    images: doc.images ?? [],
    barcode: doc.barcode,

    baseUom: doc.baseUom,
    packs: (doc.packs ?? []).map((p) => ({
      code: p.code,
      name: p.name,
      factor: p.factor,
      barcode: p.barcode ?? null,
    })),
    trackingMode: doc.trackingMode,

    hasVariants: doc.hasVariants,
    variantAxes: doc.variantAxes ?? [],

    taxRatePct: doc.taxRatePct,
    hsCode: doc.hsCode,

    mrpMinor: doc.mrpMinor,
    defaultSellPriceMinor: doc.defaultSellPriceMinor,
    ...(includeCost
      ? { standardCostMinor: doc.standardCostMinor, avgCostMinor: doc.avgCostMinor }
      : {}),

    reorderPoint: doc.reorderPoint,
    reorderQty: doc.reorderQty,
    leadTimeDays: doc.leadTimeDays,

    isActive: doc.isActive,
    isSellableAtCounter: doc.isSellableAtCounter,
    isSellableWholesale: doc.isSellableWholesale,

    attrs: doc.attrs,

    ...(brandName === undefined ? {} : { brandName }),
    ...(categoryName === undefined ? {} : { categoryName }),

    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
