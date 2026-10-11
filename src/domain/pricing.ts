/**
 * The pricing engine — §6.6 of the project plan.
 *
 * **Pure.** No database, no clock, no request: every input is passed in, so every branch is a
 * unit test and the same inputs always give the same price. The service (`modules/pricing`)
 * loads the rows; this decides.
 *
 * Two jobs:
 *
 *  1. `resolvePrice` — what one dealer pays for a quantity of one product, in one unit, on one
 *     day, and a trace of *why*: which rule won and why every earlier rule did not.
 *  2. `computeTotals` — line and order totals, with an order-level discount prorated down to the
 *     lines by largest remainder so `sum(lines) === total` to the poisha, always.
 *
 * Tax is deliberately absent. Whether prices are VAT-inclusive, and whether invoices need the
 * Mushak 6.3 layout, is open question 1 in §13; the totals grow a tax column once it is answered
 * rather than guessing now and unpicking it later.
 */

import { prorate, roundHalfUp } from '../shared/money.js';
import { windowsOverlap } from '../shared/pricing.js';
import { packFactor, toBase } from '../shared/uom.js';

import type { UomCarrier } from '../shared/uom.js';
import type {
  PriceResolution,
  PriceSource,
  PriceStepOutcome,
  PriceStepTrace,
} from '../shared/types.js';

// ─── Errors ─────────────────────────────────────────────────────────────────────────────

/** A request the engine cannot price — the service turns it into a 422 on `field`. */
export class PricingError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'PricingError';
    this.field = field;
  }
}

// ─── Inputs ─────────────────────────────────────────────────────────────────────────────

/** An entry as the engine needs it — plain strings, so tests need no ObjectIds. */
export interface EntryLike {
  id: string;
  tierId: string | null;
  partyId: string | null;
  variantId: string | null;
  uomCode: string;
  priceMinor: number;
  minQty: number;
  /** `YYYY-MM-DD`, inclusive, null = open. */
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

export interface ResolveInput {
  productId: string;
  product: UomCarrier & { defaultSellPriceMinor: number };
  variant: { id: string; priceDeltaMinor: number } | null;
  /** Null for a counter sale to a walk-in — steps 1 and 2 do not apply. */
  dealer: { partyId: string; tierId: string | null; discountPct: number } | null;
  /** `org.settings.defaultRetailTierId`. */
  retailTierId: string | null;
  uomCode: string;
  /** In `uomCode`. A whole number ≥ 1. */
  qty: number;
  /** `YYYY-MM-DD` — the caller's "today" in the org's time zone, or a quote date. */
  date: string;
  /** Every entry for this product in any of the scopes above; the engine filters the rest. */
  entries: readonly EntryLike[];
  /** Display names for the trace, keyed by tier id or party id. Optional. */
  names?: Record<string, string>;
}

// ─── Choosing within one list ───────────────────────────────────────────────────────────

interface Pick {
  entry: EntryLike;
  /** Per requested unit, before any trade discount. */
  unitPriceMinor: number;
  converted: boolean;
  nextBreak: { minQty: number; uomCode: string; unitPriceMinor: number } | null;
}

type ScopeResult =
  | { kind: 'MATCHED'; pick: Pick }
  | { kind: 'NO_ENTRY' }
  | { kind: 'BELOW_MIN_QTY'; needs: number; uomCode: string };

/**
 * Pick the price from one list (one dealer's, or one tier's).
 *
 * Preference, most specific first — the first group that yields a price wins:
 *
 *   1. this variant, priced in the requested unit
 *   2. this variant, priced per base unit (scaled up by the pack factor)
 *   3. the whole product, in the requested unit
 *   4. the whole product, per base unit (scaled)
 *
 * Variant beats unit because a variant price is a deliberate statement about *that* item — a
 * high-cylinder lens that costs more to make — while a per-piece price scaled to a dozen is the
 * same price expressed differently. Only base-unit entries are scaled, and only upwards, so the
 * conversion is a multiplication and never needs rounding.
 *
 * Within a group, the qty break is the entry with the highest `minQty` not above the quantity
 * asked for, compared in that entry's own unit.
 */
function pickFromList(
  entries: readonly EntryLike[],
  input: ResolveInput,
  qtyBase: number,
  factor: number,
): ScopeResult {
  const { uomCode, qty, variant, product, date } = input;
  const baseUom = product.baseUom;
  const inForce = entries.filter(
    (e) =>
      e.isActive &&
      windowsOverlap(
        { validFrom: e.validFrom, validTo: e.validTo },
        { validFrom: date, validTo: date },
      ),
  );

  const groups: { variantMatch: boolean; unit: 'EXACT' | 'BASE' }[] = [
    { variantMatch: true, unit: 'EXACT' },
    { variantMatch: true, unit: 'BASE' },
    { variantMatch: false, unit: 'EXACT' },
    { variantMatch: false, unit: 'BASE' },
  ];

  let smallestUnmet: { needs: number; uomCode: string } | null = null;

  for (const group of groups) {
    if (group.variantMatch && !variant) continue;
    // Scaling from the base unit to the base unit is just the exact case again.
    if (group.unit === 'BASE' && uomCode === baseUom) continue;

    const candidates = inForce.filter(
      (e) =>
        (group.variantMatch ? e.variantId === variant?.id : e.variantId === null) &&
        e.uomCode === (group.unit === 'EXACT' ? uomCode : baseUom),
    );
    if (candidates.length === 0) continue;

    // Compare breaks in the entry's own unit: a per-piece break of 60 is met by 5 dozen.
    const asked = group.unit === 'EXACT' ? qty : qtyBase;
    const scale = group.unit === 'EXACT' ? 1 : factor;
    const sorted = [...candidates].sort((a, b) => a.minQty - b.minQty);
    const met = sorted.filter((e) => e.minQty <= asked);

    if (met.length === 0) {
      const first = sorted[0]!;
      if (!smallestUnmet) smallestUnmet = { needs: first.minQty, uomCode: first.uomCode };
      continue;
    }

    const entry = met[met.length - 1]!;
    const next = sorted.find((e) => e.minQty > asked) ?? null;

    return {
      kind: 'MATCHED',
      pick: {
        entry,
        unitPriceMinor: entry.priceMinor * scale,
        converted: group.unit === 'BASE',
        nextBreak: next
          ? {
              minQty: next.minQty,
              uomCode: next.uomCode,
              unitPriceMinor: next.priceMinor * scale,
            }
          : null,
      },
    };
  }

  return smallestUnmet ? { kind: 'BELOW_MIN_QTY', ...smallestUnmet } : { kind: 'NO_ENTRY' };
}

// ─── Resolution ─────────────────────────────────────────────────────────────────────────

const STEP_LABEL: Record<PriceSource, string> = {
  DEALER: "Dealer's own price",
  TIER: "Dealer's tier",
  RETAIL: 'Retail (counter) tier',
  PRODUCT_DEFAULT: "Product's default sell price",
};

/** Unit price after a trade discount, rounded once, per unit — so the line total stays exact. */
function discounted(unitMinor: number, pct: number): number {
  return pct > 0 ? unitMinor - roundHalfUp((unitMinor * pct) / 100) : unitMinor;
}

/**
 * Resolve a price, following §6.6 in order:
 *
 *   1. the dealer's own price list
 *   2. the dealer's tier
 *   3. the org's default retail tier
 *   4. the product's default sell price plus the variant's delta
 *
 * A step that has entries but none low enough for the quantity (`BELOW_MIN_QTY`) falls through
 * to the next step rather than failing: "from 5 dozen" says nothing about 3 dozen, so the next
 * rule decides.
 *
 * **The dealer's `discountPct`** applies to steps 2–4 and **not** to step 1. A dealer-specific
 * price is already the negotiated number; discounting it again would give the dealer their
 * discount twice. The variant delta applies to step 4 only — a list entry, even an
 * all-variants one, is a price someone typed, and adding a delta to it would quote a number
 * nobody agreed.
 */
export function resolvePrice(input: ResolveInput): PriceResolution {
  const { product, uomCode, qty, dealer, retailTierId, variant, entries, names = {} } = input;

  if (!Number.isInteger(qty) || qty < 1) {
    throw new PricingError('qty', 'A whole quantity of 1 or more');
  }
  const factor = packFactor(product, uomCode);
  if (factor === null) {
    const units = [product.baseUom, ...product.packs.map((p) => p.code)].join(', ');
    throw new PricingError('uomCode', `This product is sold in ${units} — not ${uomCode}`);
  }
  const qtyBase = toBase(qty, uomCode, product);

  const trace: PriceStepTrace[] = [];
  let winner: { source: PriceSource; pick: Pick | null; scopeName: string | null } | null =
    null;

  const record = (step: PriceSource, outcome: PriceStepOutcome, note: string) =>
    trace.push({ step, outcome, note });

  const tryList = (step: PriceSource, list: readonly EntryLike[], scopeName: string) => {
    if (winner) {
      record(step, 'NOT_REACHED', 'An earlier rule already set the price.');
      return;
    }
    const result = pickFromList(list, input, qtyBase, factor);
    if (result.kind === 'MATCHED') {
      const e = result.pick.entry;
      record(
        step,
        'MATCHED',
        `${scopeName}: ${e.uomCode} from ${e.minQty}` +
          (result.pick.converted ? `, scaled ×${factor} to ${uomCode}` : '') +
          (e.variantId ? ', this variant' : ''),
      );
      winner = { source: step, pick: result.pick, scopeName };
    } else if (result.kind === 'BELOW_MIN_QTY') {
      record(
        step,
        'BELOW_MIN_QTY',
        `${scopeName} starts at ${result.needs} ${result.uomCode}.`,
      );
    } else {
      record(step, 'NO_ENTRY', `${scopeName} has no price for this item and unit today.`);
    }
  };

  // 1. The dealer's own prices.
  if (!dealer) record('DEALER', 'NOT_APPLICABLE', 'No dealer — a counter sale.');
  else {
    tryList(
      'DEALER',
      entries.filter((e) => e.partyId === dealer.partyId),
      names[dealer.partyId] ?? STEP_LABEL.DEALER,
    );
  }

  // 2. The dealer's tier.
  if (!dealer) record('TIER', 'NOT_APPLICABLE', 'No dealer — a counter sale.');
  else if (!dealer.tierId)
    record('TIER', winner ? 'NOT_REACHED' : 'NOT_APPLICABLE', 'The dealer has no tier.');
  else {
    const tierId = dealer.tierId;
    tryList(
      'TIER',
      entries.filter((e) => e.tierId === tierId && e.partyId === null),
      names[tierId] ?? STEP_LABEL.TIER,
    );
  }

  // 3. The retail tier — skipped when it *is* the dealer's tier, which step 2 already tried.
  if (!retailTierId) {
    record(
      'RETAIL',
      winner ? 'NOT_REACHED' : 'NOT_APPLICABLE',
      'No default retail tier is set.',
    );
  } else if (dealer?.tierId === retailTierId) {
    record('RETAIL', winner ? 'NOT_REACHED' : 'NOT_APPLICABLE', "Same as the dealer's tier.");
  } else {
    tryList(
      'RETAIL',
      entries.filter((e) => e.tierId === retailTierId && e.partyId === null),
      names[retailTierId] ?? STEP_LABEL.RETAIL,
    );
  }

  // 4. The product default, which always answers.
  const found = winner as {
    source: PriceSource;
    pick: Pick | null;
    scopeName: string | null;
  } | null;
  let listUnit: number;
  let source: PriceSource;
  let pick: Pick | null = null;
  let scopeName: string | null = null;

  if (found) {
    record('PRODUCT_DEFAULT', 'NOT_REACHED', 'An earlier rule already set the price.');
    ({ source, pick, scopeName } = found);
    listUnit = found.pick!.unitPriceMinor;
  } else {
    source = 'PRODUCT_DEFAULT';
    const delta = variant?.priceDeltaMinor ?? 0;
    // A negative delta larger than the default would quote a negative price; floor at zero.
    listUnit = Math.max(0, product.defaultSellPriceMinor + delta) * factor;
    record(
      'PRODUCT_DEFAULT',
      'MATCHED',
      listUnit === 0
        ? 'No price anywhere, and the product has no default sell price.'
        : `Default per ${product.baseUom}` +
            (delta ? ` with the variant's ${delta > 0 ? '+' : ''}${delta} delta` : '') +
            (factor > 1 ? `, ×${factor} for ${uomCode}` : ''),
    );
  }

  const discountPct = dealer && source !== 'DEALER' ? dealer.discountPct : 0;
  const unitPriceMinor = discounted(listUnit, discountPct);

  return {
    productId: input.productId,
    variantId: variant?.id ?? null,
    partyId: dealer?.partyId ?? null,
    uomCode,
    qty,
    qtyBase,
    date: input.date,

    source,
    listUnitPriceMinor: listUnit,
    discountPct,
    unitPriceMinor,
    lineTotalMinor: unitPriceMinor * qty,

    entryId: pick?.entry.id ?? null,
    entryMinQty: pick?.entry.minQty ?? null,
    entryUomCode: pick?.entry.uomCode ?? null,
    convertedFromBase: pick?.converted ?? false,
    scopeName,
    unpriced: listUnit === 0 && source === 'PRODUCT_DEFAULT',

    nextBreak: pick?.nextBreak
      ? {
          ...pick.nextBreak,
          unitPriceMinor: discounted(pick.nextBreak.unitPriceMinor, discountPct),
        }
      : null,

    trace,
  };
}

// ─── Totals ─────────────────────────────────────────────────────────────────────────────

export interface TotalsLineInput {
  unitPriceMinor: number;
  qty: number;
  /** A discount on this line alone, in minor units. */
  lineDiscountMinor?: number;
}

export type OrderDiscount =
  { kind: 'NONE' } | { kind: 'AMOUNT'; amountMinor: number } | { kind: 'PCT'; pct: number };

export interface TotalsLine {
  grossMinor: number;
  lineDiscountMinor: number;
  /** Gross less the line's own discount — the weight the order discount is prorated by. */
  netBeforeOrderMinor: number;
  /** This line's share of the order-level discount. */
  orderDiscountMinor: number;
  netMinor: number;
}

export interface Totals {
  lines: TotalsLine[];
  grossMinor: number;
  lineDiscountMinor: number;
  /** After line discounts, before the order discount. */
  subtotalMinor: number;
  orderDiscountMinor: number;
  totalMinor: number;
}

/**
 * Line and order totals.
 *
 * The order-level discount is split across the lines **by largest remainder** (`prorate`), in
 * proportion to each line's net-before-order amount. Rounding each share independently would
 * leave stray poisha — three lines each rounding ৳33.333 to ৳33.33 lose a poisha — and an
 * invoice whose lines do not add up to its total is a discrepancy an auditor will ask about. By
 * construction here, for every input:
 *
 *   sum(line.orderDiscountMinor) === orderDiscountMinor
 *   sum(line.netMinor)           === totalMinor
 *
 * The per-line share is what a later return prices a refund at, which is why it is stored on the
 * line and not recomputed.
 */
export function computeTotals(
  lines: readonly TotalsLineInput[],
  discount: OrderDiscount,
): Totals {
  const computed = lines.map((line, index) => {
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      throw new PricingError(
        `lines.${index}.unitPriceMinor`,
        'Whole minor units, not negative',
      );
    }
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      throw new PricingError(`lines.${index}.qty`, 'A whole quantity of 1 or more');
    }
    const grossMinor = line.unitPriceMinor * line.qty;
    const lineDiscountMinor = line.lineDiscountMinor ?? 0;
    if (
      !Number.isInteger(lineDiscountMinor) ||
      lineDiscountMinor < 0 ||
      lineDiscountMinor > grossMinor
    ) {
      throw new PricingError(
        `lines.${index}.lineDiscountMinor`,
        'Between 0 and the line amount',
      );
    }
    return {
      grossMinor,
      lineDiscountMinor,
      netBeforeOrderMinor: grossMinor - lineDiscountMinor,
    };
  });

  const grossMinor = computed.reduce((s, l) => s + l.grossMinor, 0);
  const lineDiscountMinor = computed.reduce((s, l) => s + l.lineDiscountMinor, 0);
  const subtotalMinor = grossMinor - lineDiscountMinor;

  let orderDiscountMinor = 0;
  if (discount.kind === 'AMOUNT') {
    orderDiscountMinor = discount.amountMinor;
    if (!Number.isInteger(orderDiscountMinor) || orderDiscountMinor < 0) {
      throw new PricingError('orderDiscount', 'Whole minor units, not negative');
    }
  } else if (discount.kind === 'PCT') {
    if (!Number.isFinite(discount.pct) || discount.pct < 0 || discount.pct > 100) {
      throw new PricingError('orderDiscount', 'A percentage from 0 to 100');
    }
    orderDiscountMinor = roundHalfUp((subtotalMinor * discount.pct) / 100);
  }
  if (orderDiscountMinor > subtotalMinor) {
    throw new PricingError('orderDiscount', 'Cannot exceed the order subtotal');
  }

  const shares =
    computed.length > 0
      ? prorate(
          orderDiscountMinor,
          computed.map((l) => l.netBeforeOrderMinor),
        )
      : [];

  const out: TotalsLine[] = computed.map((l, i) => ({
    ...l,
    orderDiscountMinor: shares[i]!,
    netMinor: l.netBeforeOrderMinor - shares[i]!,
  }));

  return {
    lines: out,
    grossMinor,
    lineDiscountMinor,
    subtotalMinor,
    orderDiscountMinor,
    totalMinor: subtotalMinor - orderDiscountMinor,
  };
}

/**
 * An invoice total rounded as the org asks (`settings.roundInvoiceTo`, Day 39): to the nearest
 * multiple of `stepMinor`, halves up — 100 rounds ৳1,234.50 to ৳1,235. 0 or 1 means no rounding.
 * The difference is recorded on the invoice as `roundingMinor`, so lines + shipping + rounding
 * still add up to the total, to the poisha.
 */
export function roundTotal(
  totalMinor: number,
  stepMinor: number,
): { totalMinor: number; roundingMinor: number } {
  if (!Number.isInteger(totalMinor)) throw new RangeError('roundTotal: whole minor units');
  if (!stepMinor || stepMinor <= 1) return { totalMinor, roundingMinor: 0 };
  const rounded = Math.floor((totalMinor + stepMinor / 2) / stepMinor) * stepMinor;
  return { totalMinor: rounded, roundingMinor: rounded - totalMinor };
}
