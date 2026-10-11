import { Schema, model } from 'mongoose';

import { STOCK_MOVEMENT_TYPES } from '../../shared/enums.js';
import { idToString } from '../../lib/model.js';

import type { StockMovementType } from '@shared/enums.js';
import type { StockLedgerPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * One stock movement — the **truth** about quantities (§6.7).
 *
 * Every change to what is on a shelf is a row here, signed: `+` in, `−` out. The balance on
 * screen is a cache of the sum of these rows (`StockBalance`), and `stock:reconcile` (Day 16)
 * proves the two agree. When someone asks "why does it say 7?", the answer is this collection,
 * filtered to that product and location — the question the retail system cannot answer, because
 * it only ever kept the 7.
 *
 * **Immutable.** There is no update or delete route, and the model refuses those operations
 * too (see the hooks below): a mistake is corrected by a *reversing* movement pointing at the
 * original through `reversalOfId`, so the ledger records both the error and its correction.
 */
export interface StockLedgerDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  postedAt: Date;
  /** `YYYYMM` in the org's time zone — see `lib/period.ts`. */
  periodKey: number;

  locationId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  /** Day 15 — lot- and serial-tracked products. Null until then. */
  lotId: Types.ObjectId | null;
  serialNo: string | null;

  /** Signed, in the product's base unit. Never zero. */
  qtyBase: number;
  movementType: StockMovementType;

  /** What caused it: `OPENING_IMPORT`, `ADJUSTMENT`, `DISPATCH`, … and that document's id/number. */
  refType: string;
  refId: Types.ObjectId | null;
  refDocNo: string | null;

  /** Cost per base unit at the time, when known. Stripped for callers without `stock:viewCost`. */
  unitCostMinor: number | null;
  /** `qtyBase × unitCostMinor`, signed like the quantity. */
  valueMinor: number | null;

  /** The balance right after this row. A snapshot for reading — never summed, never trusted. */
  balanceAfterBase: number;

  reversalOfId: Types.ObjectId | null;
  narration: string | null;

  createdBy: Types.ObjectId | null;
  createdAt: Date;
}

const stockLedgerSchema = new Schema<StockLedgerDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    postedAt: { type: Date, required: true },
    periodKey: { type: Number, required: true },

    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    lotId: { type: Schema.Types.ObjectId, ref: 'Lot', default: null },
    serialNo: { type: String, trim: true, default: null },

    qtyBase: {
      type: Number,
      required: true,
      validate: {
        validator: (v: number) => Number.isInteger(v) && v !== 0,
        message: 'A movement is a non-zero whole number of base units',
      },
    },
    movementType: { type: String, required: true, enum: STOCK_MOVEMENT_TYPES },

    refType: { type: String, required: true, trim: true },
    refId: { type: Schema.Types.ObjectId, default: null },
    refDocNo: { type: String, trim: true, default: null },

    unitCostMinor: { type: Number, default: null },
    valueMinor: { type: Number, default: null },

    balanceAfterBase: { type: Number, required: true },

    reversalOfId: { type: Schema.Types.ObjectId, ref: 'StockLedger', default: null },
    narration: { type: String, trim: true, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    collection: 'stock_ledger',
    versionKey: false,
    // `createdAt` only: a row that can never change has no `updatedAt` to keep.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/**
 * Immutability, enforced by the model and not just by the absence of a route.
 *
 * A future module that "just fixes one row" with `updateOne` would silently break the one
 * property the whole design rests on — that the ledger explains every number. These hooks make
 * that a thrown error in development instead of a discrepancy found at stock-take.
 */
const REFUSED = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

for (const op of REFUSED) {
  stockLedgerSchema.pre(op, function refuse() {
    throw new Error(
      `StockLedger is append-only: ${op} is not allowed. Post a reversing movement instead.`,
    );
  });
}
stockLedgerSchema.pre('save', function refuseResave() {
  if (!this.isNew)
    throw new Error('StockLedger is append-only: an existing row cannot be saved.');
});

// "Why is this number what it is?" — one product, one location, in time order.
stockLedgerSchema.index({ orgId: 1, productId: 1, variantId: 1, locationId: 1, postedAt: 1 });
// The ledger screen filtered by location and date, and reports by period.
stockLedgerSchema.index({ orgId: 1, locationId: 1, postedAt: -1 });
stockLedgerSchema.index({ orgId: 1, periodKey: 1, movementType: 1 });
// A serialised unit's whole history — receipt, transfers, sale — in time order (Day 15).
stockLedgerSchema.index(
  { orgId: 1, serialNo: 1, postedAt: 1 },
  { partialFilterExpression: { serialNo: { $type: 'string' } } },
);
// Every movement a document caused — what a reversal or a cancellation has to find.
stockLedgerSchema.index({ orgId: 1, refType: 1, refId: 1 });

export type StockLedgerDocument = HydratedDocument<StockLedgerDoc>;
export type StockLedgerModel = Model<StockLedgerDoc>;

// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every movement.
stockLedgerSchema.index({ orgId: 1, postedAt: -1, _id: -1 });
stockLedgerSchema.index({ orgId: 1, productId: 1, postedAt: -1, _id: -1 });
stockLedgerSchema.index({ orgId: 1, refDocNo: 1 });

export const StockLedger: StockLedgerModel = model<StockLedgerDoc>(
  'StockLedger',
  stockLedgerSchema,
);

export interface StockLedgerNames {
  productName?: string;
  sku?: string;
  variantLabel?: string | null;
  locationCode?: string;
}

export function toStockLedgerPayload(
  doc: StockLedgerDoc,
  options: { includeCost: boolean } & StockLedgerNames,
): StockLedgerPayload {
  const { includeCost, ...names } = options;
  return {
    id: String(doc._id),
    postedAt: doc.postedAt.toISOString(),
    periodKey: doc.periodKey,
    locationId: String(doc.locationId),
    productId: String(doc.productId),
    variantId: idToString(doc.variantId),
    lotId: idToString(doc.lotId),
    serialNo: doc.serialNo ?? null,
    qtyBase: doc.qtyBase,
    movementType: doc.movementType,
    refType: doc.refType,
    refId: idToString(doc.refId),
    refDocNo: doc.refDocNo ?? null,
    ...(includeCost ? { unitCostMinor: doc.unitCostMinor, valueMinor: doc.valueMinor } : {}),
    balanceAfterBase: doc.balanceAfterBase,
    reversalOfId: idToString(doc.reversalOfId),
    narration: doc.narration ?? null,
    createdBy: idToString(doc.createdBy),
    ...names,
  };
}
