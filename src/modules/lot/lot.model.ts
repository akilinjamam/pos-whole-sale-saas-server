import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A batch of a lot-tracked product — lens solution, drops — with the dates printed on the box.
 *
 * Created by the first inbound movement that names it (opening stock, a found adjustment, a goods
 * receipt on Day 33), then only ever referenced. How much of it is where lives in `LotBalance`.
 */
export interface LotDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  lotNo: string;
  mfgDate: Date | null;
  expiryDate: Date | null;
  /** The goods receipt that brought it in (Day 33); null for opening stock. */
  grnId: Types.ObjectId | null;
  unitCostMinor: number | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lotSchema = new Schema<LotDoc>(
  {
    ...auditableFields,
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    lotNo: { type: String, required: true, trim: true, uppercase: true },
    mfgDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    grnId: { type: Schema.Types.ObjectId, default: null },
    unitCostMinor: { type: Number, default: null },
  },
  { collection: 'lots' },
);

lotSchema.plugin(baseSchemaPlugin);

// A lot number identifies a batch *of one product* — two manufacturers may both print "L2401".
lotSchema.index(
  { orgId: 1, productId: 1, variantId: 1, lotNo: 1 },
  { unique: true, name: 'lot_unique' },
);
lotSchema.index({ orgId: 1, expiryDate: 1 });

export type LotDocument = HydratedDocument<LotDoc>;
// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every lot received.
lotSchema.index({ orgId: 1, expiryDate: 1, lotNo: 1 });

export const Lot: Model<LotDoc> = model<LotDoc>('Lot', lotSchema);
