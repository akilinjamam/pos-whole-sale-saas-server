import { Schema, model } from 'mongoose';

import { INITIAL_ORDER_STATUS } from '../../domain/orderStateMachine.js';
import { lineOutstanding } from '../../domain/orderQuantities.js';
import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';
import {
  BILLING_STATUSES,
  CREDIT_CHECK_STATUSES,
  FULFILLMENT_STATUSES,
  ORDER_STATUSES,
} from '../../shared/enums.js';

import type {
  BillingStatus,
  CreditCheckStatus,
  FulfillmentStatus,
  OrderStatus,
} from '@shared/enums.js';
import type { WholesaleOrderPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Query, Types } from 'mongoose';

/**
 * A dealer's order — §6.9. The wholesale channel's working document: taken as a draft, confirmed
 * (reserving stock, Day 22), picked, packed and dispatched in one or more challans (Day 24), each
 * challan raising its own invoice.
 *
 * **Status moves only through `domain/orderStateMachine.ts`.** The service's `transitionOrder` is
 * the single writer of `status` and `statusHistory`; the middleware at the bottom of this file
 * refuses every other write that touches them — a `save()` of a loaded order, a bare
 * `updateOne({ status })` from some future controller. That is the backstop for §7's rule that no
 * status is ever set by a bare `findByIdAndUpdate`.
 *
 * Quantities are base units. Each line carries five counters (§7) that only documents move:
 * reserve on confirm, dispatched and invoiced on a posted challan, cancelled on a short close,
 * returned on a sales return (Day 36). `fulfillmentStatus` and `billingStatus` are rollups of them
 * (`domain/orderQuantities.ts`), stored for indexing and recomputed by the writer — never set by hand.
 */

export interface OrderLineDoc {
  _id: Types.ObjectId;
  lineNo: number;
  productId: Types.ObjectId;
  variantId: Types.ObjectId | null;
  uomCode: string;
  uomQty: number;
  qtyBase: number;
  qtyReservedBase: number;
  qtyDispatchedBase: number;
  qtyInvoicedBase: number;
  qtyReturnedBase: number;
  qtyCancelledBase: number;
  /** Resolved server-side by the pricing engine on every save (Day 22). */
  unitPriceMinor: number;
  priceOverridden: boolean;
  originalPriceMinor: number | null;
  discountPct: number;
  /** The line's own discount plus its prorated share of the order discount. */
  discountMinor: number;
  /** VAT held at zero until open question 1 (VAT/Mushak) is answered. */
  taxPct: number;
  taxMinor: number;
  lineTotalMinor: number;
}

export interface OrderStatusHistoryDoc {
  from: OrderStatus | null;
  to: OrderStatus;
  action: string;
  at: Date;
  by: Types.ObjectId | null;
  reason: string | null;
}

export interface OrderCreditCheckDoc {
  status: CreditCheckStatus;
  checkedAt: Date;
  /** Exposure before this order (open invoices + open orders − advances), when checked. */
  outstandingMinor: number;
  /** Exposure with this order. */
  exposureMinor: number;
  limitMinor: number;
  overriddenByUserId: Types.ObjectId | null;
  overrideReason: string | null;
}

export interface OrderDiscountSpecDoc {
  kind: 'AMOUNT' | 'PCT';
  amountMinor: number;
  pct: number;
}

export interface WholesaleOrderDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  /** Null while a draft; allocated from the `SO` series on confirm, so abandoned drafts leave no gap. */
  docNo: string | null;
  dealerPartyId: Types.ObjectId;
  priceTierId: Types.ObjectId | null;
  /** The warehouse the order is reserved against and dispatched from. */
  locationId: Types.ObjectId;
  salespersonUserId: Types.ObjectId | null;
  orderDate: Date;
  requiredDate: Date | null;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  billingStatus: BillingStatus;
  lines: OrderLineDoc[];
  subtotalMinor: number;
  /** The discount as asked for (an amount or a %); null for none. */
  orderDiscount: OrderDiscountSpecDoc | null;
  orderDiscountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  roundingMinor: number;
  grandTotalMinor: number;
  creditCheck: OrderCreditCheckDoc | null;
  shippingAddress: string | null;
  billingAddress: string | null;
  paymentTermsDays: number;
  dueHint: Date | null;
  note: string | null;
  statusHistory: OrderStatusHistoryDoc[];
  confirmedAt: Date | null;
  confirmedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  isDeleted: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const qty = { type: Number, default: 0, min: 0 } as const;

const lineSchema = new Schema<OrderLineDoc>(
  {
    lineNo: { type: Number, required: true, min: 1 },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'Variant', default: null },
    uomCode: { type: String, required: true },
    uomQty: { type: Number, required: true, min: 1 },
    qtyBase: { type: Number, required: true, min: 1 },
    qtyReservedBase: qty,
    qtyDispatchedBase: qty,
    qtyInvoicedBase: qty,
    qtyReturnedBase: qty,
    qtyCancelledBase: qty,
    unitPriceMinor: { type: Number, required: true, min: 0 },
    priceOverridden: { type: Boolean, default: false },
    originalPriceMinor: { type: Number, default: null },
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    discountMinor: { type: Number, default: 0, min: 0 },
    taxPct: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    lineTotalMinor: { type: Number, required: true },
  },
  { _id: true },
);

const historySchema = new Schema<OrderStatusHistoryDoc>(
  {
    from: { type: String, enum: [...ORDER_STATUSES, null], default: null },
    to: { type: String, enum: ORDER_STATUSES, required: true },
    action: { type: String, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const creditCheckSchema = new Schema<OrderCreditCheckDoc>(
  {
    status: { type: String, enum: CREDIT_CHECK_STATUSES, required: true },
    checkedAt: { type: Date, required: true },
    outstandingMinor: { type: Number, default: 0 },
    exposureMinor: { type: Number, default: 0 },
    limitMinor: { type: Number, default: 0 },
    overriddenByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    overrideReason: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const discountSpecSchema = new Schema<OrderDiscountSpecDoc>(
  {
    kind: { type: String, enum: ['AMOUNT', 'PCT'], required: true },
    amountMinor: { type: Number, default: 0, min: 0 },
    pct: { type: Number, default: 0, min: 0, max: 100 },
  },
  { _id: false },
);

const wholesaleOrderSchema = new Schema<WholesaleOrderDoc>(
  {
    ...auditableFields,
    docNo: { type: String, default: null },
    dealerPartyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    priceTierId: { type: Schema.Types.ObjectId, ref: 'PriceTier', default: null },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    salespersonUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    orderDate: { type: Date, required: true },
    requiredDate: { type: Date, default: null },
    status: { type: String, enum: ORDER_STATUSES, default: INITIAL_ORDER_STATUS },
    fulfillmentStatus: { type: String, enum: FULFILLMENT_STATUSES, default: 'NONE' },
    billingStatus: { type: String, enum: BILLING_STATUSES, default: 'UNBILLED' },
    lines: { type: [lineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0 },
    orderDiscount: { type: discountSpecSchema, default: null },
    orderDiscountMinor: { type: Number, default: 0, min: 0 },
    taxMinor: { type: Number, default: 0 },
    shippingMinor: { type: Number, default: 0, min: 0 },
    roundingMinor: { type: Number, default: 0 },
    grandTotalMinor: { type: Number, default: 0 },
    creditCheck: { type: creditCheckSchema, default: null },
    shippingAddress: { type: String, trim: true, default: null },
    billingAddress: { type: String, trim: true, default: null },
    paymentTermsDays: { type: Number, default: 0, min: 0 },
    dueHint: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
    statusHistory: { type: [historySchema], default: [] },
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { collection: 'wholesale_orders' },
);

wholesaleOrderSchema.plugin(baseSchemaPlugin);

// One number, one order. Drafts (docNo null) are exempt.
wholesaleOrderSchema.index(
  { orgId: 1, docNo: 1 },
  { unique: true, partialFilterExpression: { docNo: { $type: 'string' } } },
);
// The order board (Day 26): per-state counts and lists, newest first.
wholesaleOrderSchema.index({ orgId: 1, status: 1, orderDate: -1 });
// The dealer profile's Orders tab, and open-order exposure in the credit check (Day 31).
wholesaleOrderSchema.index({ orgId: 1, dealerPartyId: 1, status: 1, orderDate: -1 });
// Pending dispatches per warehouse — the dispatch desk and the dashboard.
wholesaleOrderSchema.index({ orgId: 1, locationId: 1, fulfillmentStatus: 1 });
wholesaleOrderSchema.index({ orgId: 1, salespersonUserId: 1, orderDate: -1 });

// ─── The status backstop ────────────────────────────────────────────────────────────────
//
// The service passes `TRANSITION_WRITE` in the query options of the one update that applies a
// transition; nothing else may touch `status` or `statusHistory`. The token is a Symbol, so it
// cannot arrive from a request body or be forged by spreading user input into options.
//
// Not covered, by Mongoose's design: `bulkWrite` and the raw driver collection skip middleware.
// Neither is used on this collection; keep it that way.

const TRANSITION_TOKEN = Symbol('wholesaleOrder.transition');

/** Query options that mark an update as the state machine's. Only `transitionOrder` uses this. */
export const TRANSITION_WRITE = { orderTransition: TRANSITION_TOKEN } as const;

const GUARDED_PATHS = ['status', 'statusHistory'] as const;

export class OrderStatusWriteError extends Error {
  constructor(how: string) {
    super(
      `Refused ${how}: an order's status and statusHistory change only through ` +
        'transitionOrder (domain/orderStateMachine.ts)',
    );
    this.name = 'OrderStatusWriteError';
  }
}

const isGuarded = (key: string) =>
  GUARDED_PATHS.some((p) => key === p || key.startsWith(`${p}.`));

/** Whether an update document writes a guarded path, under any operator. */
export function updateTouchesStatus(update: unknown): boolean {
  if (!update) return false;
  // An aggregation-pipeline update can compute anything; refuse to reason about it.
  if (Array.isArray(update)) return true;
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (!key.startsWith('$')) {
      if (isGuarded(key)) return true;
      continue;
    }
    if (value && typeof value === 'object') {
      // `$rename: { a: 'status' }` writes through its value, not its key.
      const targets =
        key === '$rename'
          ? [...Object.keys(value), ...Object.values(value).map(String)]
          : Object.keys(value);
      if (targets.some(isGuarded)) return true;
    }
  }
  return false;
}

function isTransitionWrite(query: Query<unknown, unknown>): boolean {
  return (
    (query.getOptions() as { orderTransition?: unknown }).orderTransition === TRANSITION_TOKEN
  );
}

wholesaleOrderSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  function guardStatusUpdate() {
    if (!isTransitionWrite(this) && updateTouchesStatus(this.getUpdate())) {
      throw new OrderStatusWriteError(`${(this as { op?: string }).op} of status`);
    }
  },
);

wholesaleOrderSchema.pre(['replaceOne', 'findOneAndReplace'], function guardReplace() {
  if (!isTransitionWrite(this))
    throw new OrderStatusWriteError(`${(this as { op?: string }).op} of an order`);
});

wholesaleOrderSchema.pre('save', function guardSave() {
  if (this.isNew) {
    if (this.status !== INITIAL_ORDER_STATUS) {
      throw new OrderStatusWriteError(`creating an order as ${this.status}`);
    }
    // Creation is the first line of the timeline.
    if (this.statusHistory.length === 0) {
      this.statusHistory.push({
        from: null,
        to: INITIAL_ORDER_STATUS,
        action: 'create',
        at: new Date(),
        by: this.createdBy,
        reason: null,
      });
    }
    return;
  }
  if (GUARDED_PATHS.some((p) => this.isModified(p))) {
    throw new OrderStatusWriteError('save() of a changed status');
  }
});

wholesaleOrderSchema.pre('insertMany', function guardInsertMany(next, docs: unknown) {
  const list = (Array.isArray(docs) ? docs : [docs]) as { status?: string }[];
  if (list.some((d) => d.status !== undefined && d.status !== INITIAL_ORDER_STATUS)) {
    return next(new OrderStatusWriteError('insertMany of a non-draft order'));
  }
  next();
});

export type WholesaleOrderDocument = HydratedDocument<WholesaleOrderDoc>;
// Day 40 index review: the list screen's default order, served by the index rather than sorted
// in memory — this collection grows with every order.
wholesaleOrderSchema.index({ orgId: 1, orderDate: -1 });
wholesaleOrderSchema.index({ orgId: 1, dealerPartyId: 1, orderDate: -1 });

export const WholesaleOrder: Model<WholesaleOrderDoc> = model<WholesaleOrderDoc>(
  'WholesaleOrder',
  wholesaleOrderSchema,
);

// ─── Wire shape ─────────────────────────────────────────────────────────────────────────

export interface OrderPayloadExtras {
  availableActions: WholesaleOrderPayload['availableActions'];
  dealerName?: string;
  locationName?: string;
  product?: (id: Types.ObjectId) => { name: string; sku: string } | undefined;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toWholesaleOrderPayload(
  doc: WholesaleOrderDoc,
  extras: OrderPayloadExtras,
): WholesaleOrderPayload {
  return {
    id: String(doc._id),
    docNo: doc.docNo,
    dealerPartyId: String(doc.dealerPartyId),
    dealerName: extras.dealerName,
    priceTierId: idToString(doc.priceTierId),
    locationId: String(doc.locationId),
    locationName: extras.locationName,
    salespersonUserId: idToString(doc.salespersonUserId),
    orderDate: doc.orderDate.toISOString(),
    requiredDate: iso(doc.requiredDate),
    status: doc.status,
    fulfillmentStatus: doc.fulfillmentStatus,
    billingStatus: doc.billingStatus,
    lines: doc.lines.map((l) => {
      const p = extras.product?.(l.productId);
      return {
        id: String(l._id),
        lineNo: l.lineNo,
        productId: String(l.productId),
        variantId: idToString(l.variantId),
        productName: p?.name,
        sku: p?.sku,
        uomCode: l.uomCode,
        uomQty: l.uomQty,
        qtyBase: l.qtyBase,
        qtyReservedBase: l.qtyReservedBase,
        qtyDispatchedBase: l.qtyDispatchedBase,
        qtyInvoicedBase: l.qtyInvoicedBase,
        qtyReturnedBase: l.qtyReturnedBase,
        qtyCancelledBase: l.qtyCancelledBase,
        qtyOutstandingBase: lineOutstanding(l),
        unitPriceMinor: l.unitPriceMinor,
        priceOverridden: l.priceOverridden,
        originalPriceMinor: l.originalPriceMinor,
        discountPct: l.discountPct,
        discountMinor: l.discountMinor,
        taxPct: l.taxPct,
        taxMinor: l.taxMinor,
        lineTotalMinor: l.lineTotalMinor,
      };
    }),
    subtotalMinor: doc.subtotalMinor,
    orderDiscount: doc.orderDiscount
      ? doc.orderDiscount.kind === 'AMOUNT'
        ? { kind: 'AMOUNT', amountMinor: doc.orderDiscount.amountMinor }
        : { kind: 'PCT', pct: doc.orderDiscount.pct }
      : null,
    orderDiscountMinor: doc.orderDiscountMinor,
    taxMinor: doc.taxMinor,
    shippingMinor: doc.shippingMinor,
    roundingMinor: doc.roundingMinor,
    grandTotalMinor: doc.grandTotalMinor,
    creditCheck: doc.creditCheck
      ? {
          status: doc.creditCheck.status,
          checkedAt: doc.creditCheck.checkedAt.toISOString(),
          outstandingMinor: doc.creditCheck.outstandingMinor,
          exposureMinor: doc.creditCheck.exposureMinor,
          limitMinor: doc.creditCheck.limitMinor,
          overriddenByUserId: idToString(doc.creditCheck.overriddenByUserId),
          overrideReason: doc.creditCheck.overrideReason,
        }
      : null,
    shippingAddress: doc.shippingAddress,
    billingAddress: doc.billingAddress,
    paymentTermsDays: doc.paymentTermsDays,
    note: doc.note,
    statusHistory: doc.statusHistory.map((h) => ({
      from: h.from,
      to: h.to,
      action: h.action,
      at: h.at.toISOString(),
      byUserId: idToString(h.by),
      reason: h.reason,
    })),
    availableActions: extras.availableActions,
    confirmedAt: iso(doc.confirmedAt),
    cancelledAt: iso(doc.cancelledAt),
    cancelReason: doc.cancelReason,
    closedAt: iso(doc.closedAt),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
