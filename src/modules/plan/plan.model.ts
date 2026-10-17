import { Schema, model } from 'mongoose';

import { PLAN_FEATURES } from '../../shared/enums.js';

import type { LimitedResource, PlanFeature } from '@shared/enums.js';
import type { PlanPayload } from '@shared/types.js';
import type { Model, Types } from 'mongoose';

/**
 * A subscription plan — SaaS phase 4.
 *
 * Platform-level: **no `orgId`**. Plans are the platform's price list, shared by every business,
 * and one of the few collections that is not tenant data (SAAS-WORK-PLAN §4). A business points
 * at one by `Org.planCode`.
 *
 * Limits of `null` are unlimited. Prices are in minor units, like every other amount.
 */
export interface PlanDoc {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description: string | null;
  priceMonthlyMinor: number;
  priceYearlyMinor: number;
  limits: Record<LimitedResource, number | null>;
  features: PlanFeature[];
  /** Offered to new businesses. An inactive plan keeps working for those already on it. */
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const limit = { type: Number, min: 0, default: null };

const planSchema = new Schema<PlanDoc>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: null },
    priceMonthlyMinor: { type: Number, required: true, min: 0 },
    priceYearlyMinor: { type: Number, required: true, min: 0 },
    limits: {
      users: limit,
      locations: limit,
      products: limit,
    },
    features: { type: [{ type: String, enum: PLAN_FEATURES }], default: [] },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'plans' },
);

planSchema.index({ code: 1 }, { unique: true });

export const Plan: Model<PlanDoc> = model<PlanDoc>('Plan', planSchema);

export function toPlanPayload(doc: PlanDoc): PlanPayload {
  return {
    code: doc.code,
    name: doc.name,
    description: doc.description ?? null,
    priceMonthlyMinor: doc.priceMonthlyMinor,
    priceYearlyMinor: doc.priceYearlyMinor,
    limits: {
      users: doc.limits?.users ?? null,
      locations: doc.limits?.locations ?? null,
      products: doc.limits?.products ?? null,
    },
    features: [...(doc.features ?? [])],
  };
}

/**
 * The plans a fresh database starts with. **The prices and limits are placeholders** — set the real
 * ones before launch (the platform admin screen, phase 5, edits them). The seed only inserts a plan
 * that is missing; it never overwrites one that has been edited.
 */
export const DEFAULT_PLANS: Omit<PlanDoc, '_id' | 'createdAt' | 'updatedAt'>[] = [
  {
    code: 'STARTER',
    name: 'Starter',
    description:
      'Wholesale orders, dispatch, invoices, dealer credit, and receiving from suppliers — for a small team.',
    priceMonthlyMinor: 150_000,
    priceYearlyMinor: 1_500_000,
    limits: { users: 3, locations: 2, products: 500 },
    features: [],
    isActive: true,
    sortOrder: 1,
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    description: 'Everything in Starter, plus the counter POS, purchase orders and the report suite.',
    priceMonthlyMinor: 350_000,
    priceYearlyMinor: 3_500_000,
    limits: { users: 10, locations: 5, products: 5_000 },
    features: ['POS', 'PURCHASING', 'REPORTS'],
    isActive: true,
    sortOrder: 2,
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    description: 'Everything, with no limits on users, warehouses or products.',
    priceMonthlyMinor: 750_000,
    priceYearlyMinor: 7_500_000,
    limits: { users: null, locations: null, products: null },
    features: ['POS', 'PURCHASING', 'REPORTS'],
    isActive: true,
    sortOrder: 3,
  },
];
