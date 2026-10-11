import { Schema, model } from 'mongoose';

import { SERIAL_STATUSES } from '../../shared/enums.js';
import { baseSchemaPlugin } from '../../lib/model.js';

import type { SerialStatus } from '@shared/enums.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * One serialised unit — a lensmeter, an autorefractor — followed from receipt to sale and beyond.
 *
 * Its `status` and `locationId` are set only by `stock.service`, from the movement that moved it,
 * and every such movement is a ledger row carrying this `serialNo`. So "where is unit X, and how
 * did it get there?" has two answers that cannot disagree: this document now, the ledger rows for
 * the history.
 *
 * The warranty clock starts at the **sale**, not at receipt: `warrantyMonths` is snapshotted from
 * the product when the unit first arrives, and `warrantyStartAt` is set when it is sold.
 */
export interface SerialUnitDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  serialNo: string;
  status: SerialStatus;
  /** Where it physically is; null when it is not on any shelf of ours (sold, scrapped, …). */
  locationId: Types.ObjectId | null;
  lotId: Types.ObjectId | null;
  grnId: Types.ObjectId | null;
  unitCostMinor: number | null;
  receivedAt: Date;
  lastMovementAt: Date;

  soldInvoiceId: Types.ObjectId | null;
  soldPartyId: Types.ObjectId | null;
  soldAt: Date | null;
  sellPriceMinor: number | null;

  warrantyMonths: number | null;
  warrantyStartAt: Date | null;
  warrantyEndAt: Date | null;
  installedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const serialUnitSchema = new Schema<SerialUnitDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    serialNo: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: SERIAL_STATUSES, required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
    lotId: { type: Schema.Types.ObjectId, ref: 'Lot', default: null },
    grnId: { type: Schema.Types.ObjectId, default: null },
    unitCostMinor: { type: Number, default: null },
    receivedAt: { type: Date, required: true },
    lastMovementAt: { type: Date, required: true },

    soldInvoiceId: { type: Schema.Types.ObjectId, default: null },
    soldPartyId: { type: Schema.Types.ObjectId, ref: 'Party', default: null },
    soldAt: { type: Date, default: null },
    sellPriceMinor: { type: Number, default: null },

    warrantyMonths: { type: Number, default: null },
    warrantyStartAt: { type: Date, default: null },
    warrantyEndAt: { type: Date, default: null },
    installedAt: { type: Date, default: null },
  },
  { collection: 'serial_units' },
);

serialUnitSchema.plugin(baseSchemaPlugin);

/**
 * Unique **per org**, not per product (§6.4): a serial number is how a customer, a supplier and a
 * service engineer all refer to one physical unit, and two units answering to the same number is
 * a warranty claim nobody can settle.
 */
serialUnitSchema.index({ orgId: 1, serialNo: 1 }, { unique: true, name: 'serial_unique' });
serialUnitSchema.index({ orgId: 1, productId: 1, status: 1 });
serialUnitSchema.index({ orgId: 1, locationId: 1, status: 1 });
serialUnitSchema.index({ orgId: 1, warrantyEndAt: 1 });

export type SerialUnitDocument = HydratedDocument<SerialUnitDoc>;
// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every serialised unit.
serialUnitSchema.index({ orgId: 1, lastMovementAt: -1 });

export const SerialUnit: Model<SerialUnitDoc> = model<SerialUnitDoc>(
  'SerialUnit',
  serialUnitSchema,
);
