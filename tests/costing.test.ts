import { describe, expect, it } from 'vitest';

import {
  currentCost,
  landedValues,
  movingAverage,
  movingAverageOut,
} from '../src/domain/costing.js';

/** Day 33: moving-average cost, one per item across every location, and landed cost. */

describe('currentCost', () => {
  it('weights each location by what is on its shelf', () => {
    // 60 at ৳40 in the warehouse, 20 at ৳44 at the counter: ৳41 on average.
    expect(
      currentCost([
        { qtyOnHand: 60, avgCostMinor: 4_000 },
        { qtyOnHand: 20, avgCostMinor: 4_400 },
      ]),
    ).toEqual({ qtyOnHand: 80, avgCostMinor: 4_100 });
  });

  it('ignores empty and negative rows — nothing there to have cost anything', () => {
    expect(
      currentCost([
        { qtyOnHand: 0, avgCostMinor: 9_999 },
        { qtyOnHand: -3, avgCostMinor: 9_999 },
        { qtyOnHand: 10, avgCostMinor: 5_000 },
      ]),
    ).toEqual({ qtyOnHand: 10, avgCostMinor: 5_000 });
    expect(currentCost([])).toEqual({ qtyOnHand: 0, avgCostMinor: 0 });
  });
});

describe('movingAverage', () => {
  it('blends what was on the shelf with what arrived', () => {
    // 60 at ৳40 + 24 arriving for ৳1,152 (৳48 each) = 84 at ৳42.29
    expect(movingAverage({ qtyOnHand: 60, avgCostMinor: 4_000 }, 24, 115_200)).toBe(4_229);
  });

  it('an empty (or negative) shelf takes the incoming cost as it is', () => {
    expect(movingAverage({ qtyOnHand: 0, avgCostMinor: 4_000 }, 10, 50_000)).toBe(5_000);
    expect(movingAverage({ qtyOnHand: -4, avgCostMinor: 4_000 }, 10, 50_000)).toBe(5_000);
  });

  it('free goods pull the average down, as they should', () => {
    expect(movingAverage({ qtyOnHand: 10, avgCostMinor: 5_000 }, 10, 0)).toBe(2_500);
  });

  it('refuses nonsense arriving', () => {
    expect(() => movingAverage({ qtyOnHand: 1, avgCostMinor: 1 }, 0, 1)).toThrow(RangeError);
    expect(() => movingAverage({ qtyOnHand: 1, avgCostMinor: 1 }, 1, -1)).toThrow(RangeError);
  });
});

describe('landedValues', () => {
  it('spreads other charges by line value, and the lines add up to the receipt exactly', () => {
    const v = landedValues([96_000, 7_600_000, 1], 10_001);
    expect(v.reduce((a, b) => a + b, 0)).toBe(96_000 + 7_600_000 + 1 + 10_001);
    expect(v[1]! - 7_600_000).toBeGreaterThan(v[0]! - 96_000);
  });

  it('no charges: each line lands at its own value', () => {
    expect(landedValues([100, 200], 0)).toEqual([100, 200]);
  });

  it('free goods only: the charges are spread evenly', () => {
    expect(landedValues([0, 0, 0], 100)).toEqual([34, 33, 33]);
  });
});

describe('movingAverageOut', () => {
  it('returned at the average, the average stands', () => {
    expect(movingAverageOut({ qtyOnHand: 20, avgCostMinor: 4_000 }, 5, 20_000)).toBe(4_000);
  });

  it('returned at the bill price, what is left carries the freight the supplier keeps', () => {
    // 12 frames landed at ৳40.25 (bill ৳38 + freight); 2 go back for ৳76 — the 10 left absorb it.
    expect(movingAverageOut({ qtyOnHand: 12, avgCostMinor: 4_025 }, 2, 7_600)).toBe(4_070);
  });

  it('nothing left: the average stands for the next document', () => {
    expect(movingAverageOut({ qtyOnHand: 3, avgCostMinor: 4_000 }, 3, 15_000)).toBe(4_000);
    expect(movingAverageOut({ qtyOnHand: 0, avgCostMinor: 4_000 }, 1, 15_000)).toBe(4_000);
  });

  it('never below zero', () => {
    expect(movingAverageOut({ qtyOnHand: 2, avgCostMinor: 100 }, 1, 1_000)).toBe(0);
  });

  it('refuses nonsense leaving', () => {
    expect(() => movingAverageOut({ qtyOnHand: 1, avgCostMinor: 1 }, 0, 1)).toThrow(RangeError);
    expect(() => movingAverageOut({ qtyOnHand: 1, avgCostMinor: 1 }, 1, -1)).toThrow(
      RangeError,
    );
  });
});

describe('roundTotal (Day 39)', () => {
  it('rounds to the nearest step, halves up, and reports the difference', async () => {
    const { roundTotal } = await import('../src/domain/pricing.js');
    expect(roundTotal(18_111, 100)).toEqual({ totalMinor: 18_100, roundingMinor: -11 });
    expect(roundTotal(18_150, 100)).toEqual({ totalMinor: 18_200, roundingMinor: 50 });
    expect(roundTotal(18_149, 50)).toEqual({ totalMinor: 18_150, roundingMinor: 1 });
    expect(roundTotal(18_111, 0)).toEqual({ totalMinor: 18_111, roundingMinor: 0 });
    expect(roundTotal(18_111, 1)).toEqual({ totalMinor: 18_111, roundingMinor: 0 });
  });
});
