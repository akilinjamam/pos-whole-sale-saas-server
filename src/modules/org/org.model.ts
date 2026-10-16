import { Schema, model } from 'mongoose';

import { baseSchemaPlugin } from '../../lib/model.js';

import { ORG_STATUSES, SIGNUP_SOURCES } from '../../shared/enums.js';

import type { OrgStatus, SignupSource } from '@shared/enums.js';
import type { OrgPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * The stored shape of `settings`. It differs from `OrgSettings` in `@shared/types` by exactly
 * one field — `defaultRetailTierId` is an ObjectId on disk and a string on the wire — which is
 * why the serializer below exists rather than the document being returned directly.
 */
export interface OrgSettingsDoc {
  invoiceOnDispatch: boolean;
  allowNegativeStock: boolean;
  enforceCreditLimit: boolean;
  defaultRetailTierId: Types.ObjectId | null;
  roundInvoiceTo: number;
  defaultPaymentTermsDays: number;
}

/**
 * The tenant. Every other collection carries `orgId` (§6.1), which is what lets one database
 * hold many businesses. New ones are created only by `services/provisioning.service.ts`.
 *
 * The subscription fields (`status`, `planCode`, `trialEndsAt`, `currentPeriodEndsAt`) are
 * recorded from SaaS phase 1 and enforced from phase 4.
 *
 * `settings` is where the business rules that have to be changeable without a deploy live.
 * Each flag is read at the exact point it decides something:
 *   `invoiceOnDispatch`   → dispatch posting, whether an Invoice is raised with the challan
 *   `allowNegativeStock`  → stock.service, whether an OUT may drive a balance below zero
 *   `enforceCreditLimit`  → order confirm and dispatch post
 *   `roundInvoiceTo`      → invoice totalling, in minor units (0 = no rounding)
 */
export interface OrgDoc {
  _id: Types.ObjectId;
  name: string;
  legalName: string | null;
  bin: string | null;
  vatRegNo: string | null;
  tin: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  logoUrl: string | null;
  /** A line under the letterhead on every A4 invoice — "Authorised distributor of …". */
  invoiceHeaderNote: string | null;
  /** The foot of every A4 invoice: terms, bank details, a thank-you. */
  invoiceFooter: string | null;
  currency: string;
  timeZone: string;
  fiscalYearStartMonth: number;
  settings: OrgSettingsDoc;
  /** Platform-unique, URL-safe. Null only on an org that predates SaaS phase 1. */
  slug: string | null;
  status: OrgStatus;
  planCode: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  ownerUserId: Types.ObjectId | null;
  signupSource: SignupSource;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<OrgSettingsDoc>(
  {
    invoiceOnDispatch: { type: Boolean, default: true },
    allowNegativeStock: { type: Boolean, default: false },
    enforceCreditLimit: { type: Boolean, default: true },
    defaultRetailTierId: { type: Schema.Types.ObjectId, ref: 'PriceTier', default: null },
    /** Minor units. 0 = no rounding; 100 = round the invoice total to whole taka. */
    roundInvoiceTo: { type: Number, default: 0, min: 0 },
    defaultPaymentTermsDays: { type: Number, default: 30, min: 0 },
  },
  { _id: false },
);

const orgSchema = new Schema<OrgDoc>({
  name: { type: String, required: true, trim: true },
  legalName: { type: String, trim: true, default: null },
  bin: { type: String, trim: true, default: null },
  vatRegNo: { type: String, trim: true, default: null },
  tin: { type: String, trim: true, default: null },
  phone: { type: String, trim: true, default: null },
  email: { type: String, trim: true, lowercase: true, default: null },
  address: { type: String, trim: true, default: null },
  logoUrl: { type: String, trim: true, default: null },
  invoiceHeaderNote: { type: String, trim: true, default: null },
  invoiceFooter: { type: String, trim: true, default: null },
  currency: { type: String, default: 'BDT', uppercase: true, minlength: 3, maxlength: 3 },
  timeZone: { type: String, default: 'Asia/Dhaka' },
  fiscalYearStartMonth: { type: Number, default: 7, min: 1, max: 12 },
  settings: { type: settingsSchema, default: () => ({}) },
  slug: { type: String, trim: true, lowercase: true, default: null },
  // ACTIVE by default so an org written outside provisioning (a test fixture, a restore) is
  // usable; provisioning sets TRIAL explicitly for a signup.
  status: { type: String, enum: ORG_STATUSES, default: 'ACTIVE', index: true },
  planCode: { type: String, trim: true, uppercase: true, default: null },
  trialEndsAt: { type: Date, default: null },
  currentPeriodEndsAt: { type: Date, default: null },
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  signupSource: { type: String, enum: SIGNUP_SOURCES, default: 'SEED' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
});

orgSchema.plugin(baseSchemaPlugin);

// Partial, so the null slugs of pre-SaaS orgs and test fixtures do not collide with each other.
orgSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } }, name: 'org_slug_unique' },
);

export type OrgDocument = HydratedDocument<OrgDoc>;
export type OrgModel = Model<OrgDoc>;

export const Org: OrgModel = model<OrgDoc>('Org', orgSchema);

/** Model → wire shape. The controller never hands a Mongoose document to `res.json`. */
export function toOrgPayload(doc: OrgDoc): OrgPayload {
  return {
    id: String(doc._id),
    name: doc.name,
    legalName: doc.legalName,
    bin: doc.bin,
    vatRegNo: doc.vatRegNo,
    tin: doc.tin,
    phone: doc.phone,
    email: doc.email,
    address: doc.address,
    logoUrl: doc.logoUrl,
    invoiceHeaderNote: doc.invoiceHeaderNote ?? null,
    invoiceFooter: doc.invoiceFooter ?? null,
    currency: doc.currency,
    timeZone: doc.timeZone,
    fiscalYearStartMonth: doc.fiscalYearStartMonth,
    settings: {
      invoiceOnDispatch: doc.settings.invoiceOnDispatch,
      allowNegativeStock: doc.settings.allowNegativeStock,
      enforceCreditLimit: doc.settings.enforceCreditLimit,
      defaultRetailTierId: doc.settings.defaultRetailTierId
        ? String(doc.settings.defaultRetailTierId)
        : null,
      roundInvoiceTo: doc.settings.roundInvoiceTo,
      defaultPaymentTermsDays: doc.settings.defaultPaymentTermsDays,
    },
    slug: doc.slug ?? null,
    status: doc.status ?? 'ACTIVE',
    planCode: doc.planCode ?? null,
    trialEndsAt: doc.trialEndsAt ? doc.trialEndsAt.toISOString() : null,
    currentPeriodEndsAt: doc.currentPeriodEndsAt ? doc.currentPeriodEndsAt.toISOString() : null,
  };
}
