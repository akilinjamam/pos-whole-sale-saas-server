import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { reconcileLedger } from '../../src/modules/ledger/ledger.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { openSession } from '../../src/modules/pos/posSession.service.js';
import { reconcileStock } from '../../src/modules/stock/reconcile.service.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';

/**
 * Day 40 load test — `POST /pos/sales` under contention, against the real replica set.
 *
 * Every sale of the same item writes the same balance row and the same number-series counter, so
 * concurrent sales collide on purpose: the database raises WriteConflict, and `withTransaction`
 * (with the driver's own transient-error retry) runs the loser again. What must hold:
 *
 *   - a burst of sales all succeed, numbered without gaps or repeats, and stock falls by exactly
 *     what was sold;
 *   - a race for the last units sells exactly what is on the shelf — never more — and every other
 *     sale is refused cleanly with INSUFFICIENT_STOCK, not an internal error;
 *   - afterwards, stock and party ledgers reconcile with zero drift.
 */

let f: PosFixture;
let actor: RequestActor;

const onHand = async () =>
  (
    await StockBalance.findOne({
      orgId: f.orgId,
      locationId: f.locationId,
      productId: new Types.ObjectId(f.frameId),
    }).lean()
  )?.qtyOnHand ?? 0;

const sell = (qty = 1) =>
  postPosSale(actor, {
    clientRef: randomUUID(),
    paymentMode: 'CASH',
    lines: [{ productId: f.frameId, qty }],
    tenders: [{ method: 'CASH', amountMinor: 6_000 * qty }],
  });

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
  await openSession(actor, {
    locationId: String(f.locationId),
    terminalCode: 'T1',
    openingFloatMinor: 100_000,
  });
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('POST /pos/sales under load', () => {
  it('baseline: one sale at a time (round trips to the database, no contention)', async () => {
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) await sell();
    const ms = Date.now() - started;
    console.log(`5 sequential counter sales in ${ms} ms (${Math.round(ms / 5)} ms each)`);
    expect(ms).toBeGreaterThan(0);
  }, 120_000);

  it('a burst of 25 concurrent sales: all succeed, gapless numbers, exact stock', async () => {
    const before = await onHand();
    const started = Date.now();
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => sell()));
    const ms = Date.now() - started;
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    const numbers = results
      .map(
        (r) =>
          (r as PromiseFulfilledResult<Awaited<ReturnType<typeof sell>>>).value.invoice.docNo!,
      )
      .map((d) => Number(d.split('-').pop()))
      .sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(25);
    expect(numbers.at(-1)! - numbers[0]! + 1).toBe(25); // no gaps
    expect(await onHand()).toBe(before - 25);
    console.log(
      `25 concurrent counter sales in ${ms} ms (${Math.round(ms / 25)} ms each, overlapped)`,
    );
  });

  it('a race for the last units: exactly what is on the shelf is sold, the rest refused cleanly', async () => {
    const left = await onHand(); // 30
    const attempts = left + 15;
    const results = await Promise.allSettled(Array.from({ length: attempts }, () => sell()));
    const sold = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected');
    const codes = refused.map((r) => {
      const e = (r as PromiseRejectedResult).reason as ApiError;
      return e instanceof ApiError ? e.code : String(e);
    });

    expect(sold).toBe(left);
    expect(new Set(codes)).toEqual(new Set(['INSUFFICIENT_STOCK']));
    expect(await onHand()).toBe(0);
    expect(
      await Invoice.countDocuments({ orgId: f.orgId, channel: 'COUNTER', status: 'POSTED' }),
    ).toBe(60); // the fixture's 60 frames — every one sold, none twice
  }, 180_000);

  it('afterwards: zero drift on stock and party balances', async () => {
    const stock = await reconcileStock(f.orgId);
    expect(stock.clean).toBe(true);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});
