import { Schema, model } from 'mongoose';

import { LOCATION_TYPES } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { LocationPayload } from '@shared/types.js';
import type { LocationType } from '@shared/enums.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A physical place stock can sit.
 *
 * `locationId` — not `orgId` — is this system's stock partition key (§6.1). Every balance,
 * every ledger row and every movement is scoped to a location, which is what makes
 * "what is in the Mirpur warehouse right now" a single indexed lookup rather than a scan.
 *
 * The four types are not decoration:
 *   WAREHOUSE  stock that can be sold or dispatched from
 *   COUNTER    a POS till; a shift opens against one
 *   TRANSIT    the holding leg of a two-step transfer, so in-flight stock is neither
 *              double-counted at the source nor prematurely available at the destination
 *   DAMAGE     written-off goods, kept on the books and out of available stock
 */
export interface LocationDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  code: string;
  name: string;
  type: LocationType;
  address: string | null;
  phone: string | null;
  allowsSales: boolean;
  allowsPurchase: boolean;
  isActive: boolean;
  sortOrder: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const locationSchema = new Schema<LocationDoc>({
  ...auditableFields,
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: LOCATION_TYPES },
  address: { type: String, trim: true, default: null },
  phone: { type: String, trim: true, default: null },
  allowsSales: { type: Boolean, default: true },
  allowsPurchase: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
});

locationSchema.plugin(baseSchemaPlugin);

locationSchema.index({ orgId: 1, code: 1 }, { unique: true });
locationSchema.index({ orgId: 1, type: 1 });

export type LocationDocument = HydratedDocument<LocationDoc>;
export type LocationModel = Model<LocationDoc>;

export const Location: LocationModel = model<LocationDoc>('Location', locationSchema);

export function toLocationPayload(doc: LocationDoc): LocationPayload {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    type: doc.type,
    address: doc.address,
    phone: doc.phone,
    allowsSales: doc.allowsSales,
    allowsPurchase: doc.allowsPurchase,
    isActive: doc.isActive,
    sortOrder: doc.sortOrder,
  };
}
