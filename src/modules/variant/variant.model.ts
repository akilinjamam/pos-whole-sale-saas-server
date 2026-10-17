import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { VariantPayload } from '@shared/types.js';
import type { VariantAxisValues } from '@shared/variant.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * One orderable combination of a product's axes.
 *
 * **Materialised lazily.** A single SV lens spanning sph −10..+8 and cyl 0..−4 is around 600
 * combinations; doing that for forty lens products would put 24,000 documents in front of every
 * catalogue query, almost all of which would never be stocked or sold. So `Product.attrs.grid`
 * declares what is *legal* and a variant appears only when one is actually generated, received
 * or counted — see `getOrCreateVariant`.
 *
 * `variantKey` is the identity. It is derived from the axes by `buildVariantKey`, which is
 * shared with the client, and it carries the unique index — so two concurrent goods receipts of
 * the same power cannot produce two variants, whatever order they interleave in.
 *
 * Frames use the same machinery for colour and size. A product with `hasVariants: false` never
 * gets a row here and carries `variantId: null` throughout the system — always an explicit
 * null, never undefined, so the compound indexes on stock and ledger rows behave.
 */
export interface VariantDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  productId: Types.ObjectId;
  sku: string;
  /** Canonical, derived: `SPH-2.00_CYL-1.25_AXIS180`. Unique within the product. */
  variantKey: string;
  axes: VariantAxisValues;
  barcode: string | null;
  /**
   * Added to the product's resolved price. A high-index lens costs more than the same SKU at
   * plano, and thin frames in a large size carry a premium — signed, so it can also discount.
   */
  priceDeltaMinor: number;
  /**
   * Moving-average cost of this variant across every location (Day 33, `domain/costing.ts`) —
   * written only by a goods receipt posting, never by a variant edit. Products without variants
   * keep theirs on `Product.avgCostMinor`.
   */
  avgCostMinor: number;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const variantSchema = new Schema<VariantDoc>({
  ...auditableFields,
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  sku: { type: String, required: true, trim: true, uppercase: true },
  variantKey: { type: String, required: true, trim: true },
  // Mixed rather than a sub-schema: which axes are present depends on the product's declared
  // `variantAxes`, and mongoose cannot express "these keys, for this parent". The zod schema in
  // `@shared/variant` validates it at the boundary, against the product's own declaration.
  axes: { type: Schema.Types.Mixed, required: true, default: {} },
  barcode: { type: String, trim: true, default: null },
  priceDeltaMinor: { type: Number, default: 0 },
  avgCostMinor: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
});

variantSchema.plugin(baseSchemaPlugin);

/**
 * The upsert target, and the reason concurrent receipts are safe.
 *
 * `getOrCreateVariant` does a `findOneAndUpdate` with `upsert: true` against exactly this key.
 * Two transactions racing on the same power both aim at the same index entry, so one inserts
 * and the other reads it back — instead of both inserting and the product quietly acquiring two
 * variants for the same lens, each holding half the stock.
 */
variantSchema.index({ orgId: 1, productId: 1, variantKey: 1 }, { unique: true });

variantSchema.index({ orgId: 1, sku: 1 }, { unique: true });

// Same partial-filter reasoning as `Product.barcode`: a plain unique index would treat every
// barcode-less variant's null as a value and reject the second one.
variantSchema.index(
  { orgId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);

export type VariantDocument = HydratedDocument<VariantDoc>;
export type VariantModel = Model<VariantDoc>;

export const Variant: VariantModel = model<VariantDoc>('Variant', variantSchema);

export function toVariantPayload(doc: VariantDoc, label: string): VariantPayload {
  return {
    id: String(doc._id),
    productId: String(doc.productId),
    sku: doc.sku,
    variantKey: doc.variantKey,
    axes: doc.axes,
    label,
    barcode: doc.barcode,
    priceDeltaMinor: doc.priceDeltaMinor,
    isActive: doc.isActive,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
