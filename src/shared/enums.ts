/**
 * Status and type enums shared by the server and the client.
 *
 * Declared `as const` with a derived union type so a typo is a compile error on both sides,
 * and so the arrays can drive select options in the UI without a second, drifting copy.
 */

/** Helper: the union of an `as const` string array's members. */
type Member<T extends readonly string[]> = T[number];

// ─── Catalog ────────────────────────────────────────────────────────────────────────────

export const PRODUCT_TYPES = ['FRAME', 'SUNGLASS', 'LENS', 'ACCESSORY', 'MACHINE'] as const;
export type ProductType = Member<typeof PRODUCT_TYPES>;

export const BASE_UOMS = ['PCS', 'PAIR', 'BOX', 'ML'] as const;
export type BaseUom = Member<typeof BASE_UOMS>;

export const PACK_CODES = ['PCS', 'PAIR', 'DOZ', 'CTN', 'BOX'] as const;
export type PackCode = Member<typeof PACK_CODES>;

export const TRACKING_MODES = ['NONE', 'LOT', 'SERIAL'] as const;
export type TrackingMode = Member<typeof TRACKING_MODES>;

/**
 * The axes a product may vary along.
 *
 * `Variant.axes` is keyed by these, and `Product.variantAxes` declares which ones a given
 * product actually uses — lenses vary by power (sph/cyl/axis/add), frames by colour and size.
 * Shared so the Day-7 variant grid and the server's `variantKey` builder cannot disagree about
 * the spelling of an axis, which would silently produce two variants for the same thing.
 */
export const VARIANT_AXES = ['sph', 'cyl', 'axis', 'add', 'color', 'size'] as const;
export type VariantAxis = Member<typeof VARIANT_AXES>;

// ─── Catalog: per-type attribute vocabularies ───────────────────────────────────────────
//
// These drive the `attrs` union in `catalog.ts` AND the select options in the product form.
// One declaration, so a value the form can offer is by construction a value the API accepts.

export const LENS_MATERIALS = ['CR39', 'PC', 'MR8', 'GLASS'] as const;
export type LensMaterial = Member<typeof LENS_MATERIALS>;

export const LENS_DESIGNS = ['SV', 'BIFOCAL', 'PROGRESSIVE', 'OFFICE'] as const;
export type LensDesign = Member<typeof LENS_DESIGNS>;

export const LENS_COATINGS = ['UC', 'HC', 'HMC', 'BLUECUT', 'DRIVE'] as const;
export type LensCoating = Member<typeof LENS_COATINGS>;

/** A lens sold as a PAIR is one sellable unit containing two physical lenses. */
export const LENS_SOLD_AS = ['PAIR', 'PCS'] as const;
export type LensSoldAs = Member<typeof LENS_SOLD_AS>;

export const FRAME_MATERIALS = [
  'ACETATE',
  'METAL',
  'TITANIUM',
  'TR90',
  'ULTEM',
  'COMBI',
  'WOOD',
  'OTHER',
] as const;
export type FrameMaterial = Member<typeof FRAME_MATERIALS>;

export const FRAME_SHAPES = [
  'ROUND',
  'OVAL',
  'SQUARE',
  'RECTANGLE',
  'CAT_EYE',
  'AVIATOR',
  'WAYFARER',
  'GEOMETRIC',
  'OTHER',
] as const;
export type FrameShape = Member<typeof FRAME_SHAPES>;

export const RIM_TYPES = ['FULL_RIM', 'HALF_RIM', 'RIMLESS'] as const;
export type RimType = Member<typeof RIM_TYPES>;

export const GENDERS = ['MEN', 'WOMEN', 'UNISEX', 'KIDS'] as const;
export type Gender = Member<typeof GENDERS>;

// ─── Parties ────────────────────────────────────────────────────────────────────────────

export const PARTY_ROLES = ['DEALER', 'CUSTOMER', 'SUPPLIER'] as const;
export type PartyRole = Member<typeof PARTY_ROLES>;

// ─── Tenancy (SaaS phase 1) ─────────────────────────────────────────────────────────────

/**
 * Where a business stands with its subscription. Phase 1 only records it; phase 4 enforces it
 * (`PAST_DUE` past the grace period → read-only, `SUSPENDED` / `CANCELLED` → refused).
 */
export const ORG_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
export type OrgStatus = Member<typeof ORG_STATUSES>;

/** The first-steps checklist a new business sees on its dashboard, in display order. */
export const ONBOARDING_STEPS = [
  'VERIFY_EMAIL',
  'COMPANY_DETAILS',
  'FIRST_PRODUCT',
  'FIRST_DEALER',
  'INVITE_USER',
] as const;
export type OnboardingStep = Member<typeof ONBOARDING_STEPS>;

/**
 * Parts of the product a plan can include or leave out (SaaS phase 4). The core — catalog, stock,
 * dealers, wholesale orders, dispatch, invoices, receivables — is in every plan.
 */
export const PLAN_FEATURES = ['POS', 'PURCHASING', 'REPORTS'] as const;
export type PlanFeature = Member<typeof PLAN_FEATURES>;

/** What a plan caps by count. `null` in a plan's limits means unlimited. */
export const LIMITED_RESOURCES = ['users', 'locations', 'products'] as const;
export type LimitedResource = Member<typeof LIMITED_RESOURCES>;

/** How often a business means to pay — chosen when it asks for a plan. */
export const BILLING_CYCLES = ['MONTHLY', 'YEARLY'] as const;
export type BillingCycle = Member<typeof BILLING_CYCLES>;

/**
 * What a business may do right now, given its subscription: everything, look but not change
 * (expired past the grace period), or nothing (suspended / cancelled).
 */
export const SUBSCRIPTION_ACCESS = ['FULL', 'READ_ONLY', 'BLOCKED'] as const;
export type SubscriptionAccess = Member<typeof SUBSCRIPTION_ACCESS>;

/** How a business came to exist: the seed script, the public signup page, or a platform admin. */
export const SIGNUP_SOURCES = ['SEED', 'SIGNUP', 'PLATFORM'] as const;
export type SignupSource = Member<typeof SIGNUP_SOURCES>;

// ─── Locations ──────────────────────────────────────────────────────────────────────────

export const LOCATION_TYPES = ['WAREHOUSE', 'COUNTER', 'TRANSIT', 'DAMAGE'] as const;
export type LocationType = Member<typeof LOCATION_TYPES>;

// ─── Stock ──────────────────────────────────────────────────────────────────────────────

export const STOCK_MOVEMENT_TYPES = [
  'OPENING',
  'GRN',
  'PURCHASE_RETURN',
  'SALE',
  'SALE_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'DAMAGE',
  'COUNT',
] as const;
export type StockMovementType = Member<typeof STOCK_MOVEMENT_TYPES>;

/** Movement types that must decrease stock. Everything else increases it or is signed. */
export const OUTBOUND_MOVEMENTS: readonly StockMovementType[] = [
  'SALE',
  'TRANSFER_OUT',
  'PURCHASE_RETURN',
  'DAMAGE',
];

// ─── Serials (Day 15) ───────────────────────────────────────────────────────────────────

/**
 * Where one serialised unit is in its life. Set by `stock.service` from the movement that moved
 * it — never directly — so a machine's status is always the ledger's latest word on it.
 */
export const SERIAL_STATUSES = [
  'IN_STOCK',
  /** Between the two legs of a transfer, inside one posting. */
  'IN_TRANSIT',
  /** Promised to a confirmed order (Day 22). */
  'RESERVED',
  'SOLD',
  /** Sent back to the supplier (Day 34). */
  'RETURNED',
  /** Written off: damaged, lost, missing at a count. */
  'SCRAPPED',
  /** Out on a service or repair job. */
  'IN_SERVICE',
] as const;
export type SerialStatus = Member<typeof SERIAL_STATUSES>;

export const WARRANTY_STATES = ['NONE', 'NOT_STARTED', 'ACTIVE', 'EXPIRED'] as const;
export type WarrantyState = Member<typeof WARRANTY_STATES>;

// ─── Stock documents (Day 14) ───────────────────────────────────────────────────────────

/** Why stock was adjusted. Every adjustment carries one — an unexplained write-off is a loss. */
export const ADJUSTMENT_REASONS = [
  'DAMAGED',
  'EXPIRED',
  'LOST',
  'FOUND',
  'SAMPLE',
  'CORRECTION',
  'OTHER',
] as const;
export type AdjustmentReason = Member<typeof ADJUSTMENT_REASONS>;

/**
 * A direct transfer goes DRAFT → RECEIVED in one posting. Via a transit location it stops at
 * IN_TRANSIT between the two legs — the goods are on the bus, belonging to neither shop.
 */
export const TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
export type TransferStatus = Member<typeof TRANSFER_STATUSES>;

/** COUNTING is the freeze: movements for the counted items wait until POSTED or CANCELLED. */
export const COUNT_STATUSES = ['COUNTING', 'POSTED', 'CANCELLED'] as const;
export type CountStatus = Member<typeof COUNT_STATUSES>;

// ─── Wholesale orders ───────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'PICKING',
  'PACKED',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
] as const;
export type OrderStatus = Member<typeof ORDER_STATUSES>;

export const FULFILLMENT_STATUSES = ['NONE', 'PARTIAL', 'COMPLETE'] as const;
export type FulfillmentStatus = Member<typeof FULFILLMENT_STATUSES>;

export const BILLING_STATUSES = ['UNBILLED', 'PARTIAL', 'BILLED'] as const;
export type BillingStatus = Member<typeof BILLING_STATUSES>;

export const CREDIT_CHECK_STATUSES = ['OK', 'BLOCKED', 'OVERRIDDEN'] as const;
export type CreditCheckStatus = Member<typeof CREDIT_CHECK_STATUSES>;

// ─── Dispatch ───────────────────────────────────────────────────────────────────────────

export const DISPATCH_STATUSES = [
  'DRAFT',
  'PACKED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
] as const;
export type DispatchStatus = Member<typeof DISPATCH_STATUSES>;

export const TRANSPORT_MODES = ['OWN', 'COURIER', 'BUS'] as const;
export type TransportMode = Member<typeof TRANSPORT_MODES>;

// ─── Billing ────────────────────────────────────────────────────────────────────────────

export const DOCUMENT_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type DocumentStatus = Member<typeof DOCUMENT_STATUSES>;

export const SALES_CHANNELS = ['WHOLESALE', 'COUNTER'] as const;
export type SalesChannel = Member<typeof SALES_CHANNELS>;

export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID'] as const;
export type PaymentStatus = Member<typeof PAYMENT_STATUSES>;

export const PAYMENT_METHODS = ['CASH', 'BANK', 'CHEQUE', 'MFS', 'CARD', 'ADJUSTMENT'] as const;
export type PaymentMethod = Member<typeof PAYMENT_METHODS>;

export const MFS_PROVIDERS = ['BKASH', 'NAGAD', 'ROCKET'] as const;
export type MfsProvider = Member<typeof MFS_PROVIDERS>;

export const CHEQUE_STATUSES = ['PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED'] as const;
export type ChequeStatus = Member<typeof CHEQUE_STATUSES>;

// ─── Ledger ─────────────────────────────────────────────────────────────────────────────

export const LEDGER_DOC_TYPES = [
  'OPENING',
  'INVOICE',
  'RECEIPT',
  'PAYMENT',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'ADJUSTMENT',
  'CHEQUE_BOUNCE',
  'WRITE_OFF',
  /** A supplier's bill for goods received (Day 33): credits the supplier — we owe them. */
  'PURCHASE',
] as const;
export type LedgerDocType = Member<typeof LEDGER_DOC_TYPES>;

export const AGEING_BUCKETS = ['CURRENT', '1-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = Member<typeof AGEING_BUCKETS>;

// ─── Purchasing ─────────────────────────────────────────────────────────────────────────

export const PO_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'SHORT_CLOSED',
  'CANCELLED',
] as const;
export type PoStatus = Member<typeof PO_STATUSES>;

/** A goods receipt: a draft until posted; posting is final — a mistake goes back as a return. */
export const GRN_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type GrnStatus = Member<typeof GRN_STATUSES>;

/**
 * What the store keeper found in the box. DAMAGED goods are refused at the door: recorded on the
 * receipt, but not stocked, not counted as received against the PO, and not owed to the supplier.
 */
export const QC_STATUSES = ['OK', 'DAMAGED'] as const;
export type QcStatus = Member<typeof QC_STATUSES>;

// ─── Returns ────────────────────────────────────────────────────────────────────────────

export const RETURN_REASONS = [
  'DAMAGED',
  'WRONG_ITEM',
  'NOT_SOLD',
  'WARRANTY',
  'OTHER',
] as const;
export type ReturnReason = Member<typeof RETURN_REASONS>;

export const RETURN_SETTLEMENTS = ['CREDIT_NOTE', 'CASH_REFUND', 'REPLACEMENT'] as const;
export type ReturnSettlement = Member<typeof RETURN_SETTLEMENTS>;

// ─── Document number series ─────────────────────────────────────────────────────────────

export const DOC_SERIES = [
  'WS', // wholesale invoice
  'POS', // counter invoice
  'SO', // wholesale order
  'CHL', // challan / dispatch
  'PO', // purchase order
  'GRN', // goods receipt
  'RCPT', // receipt (money in)
  'PAY', // payment (money out)
  'CN', // credit note
  'SR', // sales return
  'DN', // debit note
  'ADJ', // stock adjustment
  'TRF', // stock transfer
  'DLR', // party code
  'CNT', // stock count
  'OB', // opening-balance invoice — an old receivable loaded at cutover (Day 28)
] as const;
export type DocSeries = Member<typeof DOC_SERIES>;

// ─── Audit (Day 31) ─────────────────────────────────────────────────────────────────────

/**
 * What the audit log records. Day 31: credit overrides. Day 39: changes to the company profile,
 * the business rules and the document numbering — the edits that change how everything posts.
 */
export const AUDIT_ACTIONS = [
  'CREDIT_OVERRIDE',
  'ORG_PROFILE_CHANGE',
  'SETTINGS_CHANGE',
  'NUMBER_SERIES_CHANGE',
  'PLAN_REQUEST',
  'PLAN_REQUEST_WITHDRAW',
] as const;
export type AuditAction = Member<typeof AUDIT_ACTIONS>;

// ─── API error codes ────────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  // Distinct from UNAUTHENTICATED so the client's interceptor can tell "refresh me" apart
  // from "log out" — a seamless renewal versus bouncing a cashier out mid-sale.
  'TOKEN_EXPIRED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  // An email belongs to one user on the whole platform — login finds the business by it.
  'EMAIL_TAKEN',
  // The action needs a verified email address first (e.g. an owner adding staff).
  'EMAIL_NOT_VERIFIED',
  // A link from an email that is unknown, already used, or expired.
  'TOKEN_INVALID',
  // Public signup is switched off (SIGNUP_ENABLED=false).
  'SIGNUP_DISABLED',
  // Subscription (SaaS phase 4). 402: expired past the grace period, so changes are refused.
  'SUBSCRIPTION_EXPIRED',
  // 403: the business is suspended or cancelled.
  'ORG_SUSPENDED',
  // 409: creating one more user / location / product would exceed the plan.
  'PLAN_LIMIT_REACHED',
  // 403: the plan does not include this part of the product (POS, purchasing, reports).
  'FEATURE_NOT_IN_PLAN',
  'FORBIDDEN',
  'NOT_FOUND',
  'DUPLICATE_DOCUMENT',
  'INSUFFICIENT_STOCK',
  'CREDIT_LIMIT_EXCEEDED',
  'ILLEGAL_TRANSITION',
  // A stock count has frozen this item at this location; movements wait until it is posted.
  'STOCK_FROZEN',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = Member<typeof ERROR_CODES>;
