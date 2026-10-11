import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';
import { DISPATCH_STATUSES, TRANSPORT_MODES } from '../../shared/enums.js';

import type { DispatchStatus, TransportMode, TrackingMode } from '@shared/enums.js';
import type { DispatchPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A dispatch — the challan. §6.9, §7 "Partial dispatch".
 *
 *   DRAFT    the pick list: what to take off the shelves. Freely editable; moves nothing.
 *   PACKED   in boxes, lots and serials captured. Only the vehicle and boxes may still change.
 *   DISPATCHED posted: stock left (`SALE` movements), the order's counters moved, the challan
 *            numbered, and — with `invoiceOnDispatch` — its invoice and ledger debit posted.
 *   DELIVERED proof of delivery recorded (Day 25).
 *   CANCELLED a draft or packed challan abandoned. A posted one is never cancelled — goods that
 *            came back are a sales return (Day 36).
 *
 * One challan → one invoice: the receivable is exactly the goods that physically left.
 */

export interface DispatchLineDoc {
  _id: Types.ObjectId;
  /** The order line this ships against — validated against its outstanding quantity. */
  orderLineId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  qtyBase: number;
  lotNo: string | null;
  /** Set on posting, from `lotNo`. */
  lotId: Types.ObjectId | null;
  serials: string[];
}

export interface DispatchTransportDoc {
  mode: TransportMode;
  vehicleNo: string | null;
  driverName: string | null;
  driverPhone: string | null;
  courierName: string | null;
  trackingNo: string | null;
  freightMinor: number;
  freightPaidBy: 'US' | 'DEALER';
}

export interface DispatchDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  docNo: string | null;
  status: DispatchStatus;
  orderId: Types.ObjectId;
  orderDocNo: string | null;
  dealerPartyId: Types.ObjectId;
  locationId: Types.ObjectId;
  lines: DispatchLineDoc[];
  packages: { boxNo: string; weightKg: number | null }[];
  transport: DispatchTransportDoc | null;
  invoiceId: Types.ObjectId | null;
  invoiceDocNo: string | null;
  note: string | null;
  packedAt: Date | null;
  packedBy: Types.ObjectId | null;
  dispatchedAt: Date | null;
  dispatchedBy: Types.ObjectId | null;
  deliveredAt: Date | null;
  receivedByName: string | null;
  receivedPhone: string | null;
  /** A PNG data URL captured at the door, or null when the paper challan was signed instead. */
  receivedSignatureUrl: string | null;
  deliveryNote: string | null;
  deliveredBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<DispatchLineDoc>(
  {
    orderLineId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    qtyBase: { type: Number, required: true, min: 1 },
    lotNo: { type: String, trim: true, uppercase: true, default: null },
    lotId: { type: Schema.Types.ObjectId, ref: 'Lot', default: null },
    serials: { type: [String], default: [] },
  },
  { _id: true },
);

const transportSchema = new Schema<DispatchTransportDoc>(
  {
    mode: { type: String, enum: TRANSPORT_MODES, required: true },
    vehicleNo: { type: String, trim: true, default: null },
    driverName: { type: String, trim: true, default: null },
    driverPhone: { type: String, trim: true, default: null },
    courierName: { type: String, trim: true, default: null },
    trackingNo: { type: String, trim: true, default: null },
    freightMinor: { type: Number, default: 0, min: 0 },
    freightPaidBy: { type: String, enum: ['US', 'DEALER'], default: 'US' },
  },
  { _id: false },
);

const dispatchSchema = new Schema<DispatchDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    status: { type: String, enum: DISPATCH_STATUSES, default: 'DRAFT' },
    orderId: { type: Schema.Types.ObjectId, ref: 'WholesaleOrder', required: true },
    orderDocNo: { type: String, default: null },
    dealerPartyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    lines: { type: [lineSchema], default: [] },
    packages: {
      type: [
        new Schema(
          {
            boxNo: { type: String, required: true, trim: true },
            weightKg: { type: Number, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    transport: { type: transportSchema, default: null },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    invoiceDocNo: { type: String, default: null },
    note: { type: String, trim: true, default: null },
    packedAt: { type: Date, default: null },
    packedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    dispatchedAt: { type: Date, default: null },
    dispatchedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deliveredAt: { type: Date, default: null },
    receivedByName: { type: String, trim: true, default: null },
    receivedPhone: { type: String, trim: true, default: null },
    receivedSignatureUrl: { type: String, default: null },
    deliveryNote: { type: String, trim: true, default: null },
    deliveredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, default: null },
  },
  { collection: 'dispatches' },
);

dispatchSchema.plugin(baseSchemaPlugin);

// One challan number, one challan. Drafts and packed challans (docNo null) are exempt.
dispatchSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
// An order's challans — the order screen, and every post re-checks its siblings.
dispatchSchema.index({ orgId: 1, orderId: 1, status: 1 });
// The dispatch desk: what is waiting to be picked, packed, sent, per warehouse.
dispatchSchema.index({ orgId: 1, locationId: 1, status: 1, createdAt: -1 });
dispatchSchema.index({ orgId: 1, dealerPartyId: 1, dispatchedAt: -1 });

export type DispatchDocument = HydratedDocument<DispatchDoc>;
// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every challan.
dispatchSchema.index({ orgId: 1, createdAt: -1 });
// The dispatch register (Day 37): what left in a period.
dispatchSchema.index({ orgId: 1, status: 1, dispatchedAt: 1 });

export const Dispatch: Model<DispatchDoc> = model<DispatchDoc>('Dispatch', dispatchSchema);

export interface DispatchNames {
  dealerName?: string;
  locationName?: string;
  product?: (id: Types.ObjectId) =>
    | {
        name: string;
        sku: string;
        trackingMode: TrackingMode;
        baseUom: string;
        packs?: { code: string; factor: number }[];
      }
    | undefined;
  variantSku?: (id: Types.ObjectId | null) => string | undefined;
  /** The signature is an image: sent for one challan, never in a list. */
  withSignature?: boolean;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toDispatchPayload(
  doc: DispatchDoc,
  names: DispatchNames = {},
): DispatchPayload {
  return {
    id: String(doc._id),
    docNo: doc.docNo,
    status: doc.status,
    orderId: String(doc.orderId),
    orderDocNo: doc.orderDocNo,
    dealerPartyId: String(doc.dealerPartyId),
    dealerName: names.dealerName,
    locationId: String(doc.locationId),
    locationName: names.locationName,
    lines: doc.lines.map((l) => {
      const p = names.product?.(l.productId);
      return {
        id: String(l._id),
        orderLineId: String(l.orderLineId),
        productId: String(l.productId),
        variantId: idToString(l.variantId),
        sku: names.variantSku?.(l.variantId) ?? p?.sku,
        productName: p?.name,
        trackingMode: p?.trackingMode,
        baseUom: p?.baseUom,
        packs: p?.packs?.map((k) => ({ code: k.code, factor: k.factor })),
        qtyBase: l.qtyBase,
        lotNo: l.lotNo,
        serials: l.serials ?? [],
      };
    }),
    packages: (doc.packages ?? []).map((p) => ({
      boxNo: p.boxNo,
      weightKg: p.weightKg ?? null,
    })),
    transport: doc.transport
      ? {
          mode: doc.transport.mode,
          vehicleNo: doc.transport.vehicleNo,
          driverName: doc.transport.driverName,
          driverPhone: doc.transport.driverPhone,
          courierName: doc.transport.courierName,
          trackingNo: doc.transport.trackingNo,
          freightMinor: doc.transport.freightMinor,
          freightPaidBy: doc.transport.freightPaidBy,
        }
      : null,
    invoiceId: idToString(doc.invoiceId),
    invoiceDocNo: doc.invoiceDocNo,
    note: doc.note,
    packedAt: iso(doc.packedAt),
    dispatchedAt: iso(doc.dispatchedAt),
    deliveredAt: iso(doc.deliveredAt),
    receivedByName: doc.receivedByName ?? null,
    receivedPhone: doc.receivedPhone ?? null,
    deliveryNote: doc.deliveryNote ?? null,
    ...(names.withSignature ? { receivedSignatureUrl: doc.receivedSignatureUrl ?? null } : {}),
    cancelledAt: iso(doc.cancelledAt),
    cancelReason: doc.cancelReason,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
