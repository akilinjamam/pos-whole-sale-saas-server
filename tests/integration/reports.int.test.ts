import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { dashboard } from '../../src/modules/dashboard/dashboard.service.js';
import { Location } from '../../src/modules/location/location.model.js';
import { ageingReport } from '../../src/modules/payment/ageing.service.js';
import { Product } from '../../src/modules/product/product.model.js';
import { reorderSuggestions } from '../../src/modules/supplierPo/reorder.service.js';
import { orderCounts } from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { postReceipt } from '../../src/modules/payment/receipt.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { closeSession, openSession } from '../../src/modules/pos/posSession.service.js';
import {
  collectionRegister,
  deadStock,
  dispatchRegister,
  salesReport,
  shiftSummary,
  stockValuation,
} from '../../src/modules/reports/reports.service.js';
import { postWholesaleReturn } from '../../src/modules/salesReturn/salesReturn.service.js';
import {
  confirmOrder,
  createOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { Permission } from '../../src/shared/permissions.js';
import type { SalesReportQuery } from '../../src/shared/reports.js';

/**
 * Day 37's "done when", against a real replica set in a throwaway org:
 *   every report respects location scoping and `stock:viewCost`, and its totals tie to the
 *   ledgers underneath.
 *
 * The month: two wholesale invoices (12 and 6 frames at ৳60, costed at ৳30), 2 frames back on a
 * credit note, a cash and a bank receipt, and one counter shift selling 1 frame. Lensmeters sit
 * unsold.
 */

let f: PosFixture;
let actor: RequestActor;
let viewer: RequestActor; // reports, but no cost
let elsewhere: RequestActor; // tied to another location
const oid = (id: string) => new Types.ObjectId(id);

async function invoiced(qty: number) {
  const draft = await createOrder(actor, {
    dealerPartyId: f.dealerId,
    locationId: String(f.locationId),
    lines: [{ productId: f.frameId, qty }],
  });
  const order = await confirmOrder(actor, oid(draft.id), {});
  const d = await createDispatch(actor, { orderId: order.id });
  await packDispatch(actor, oid(d.id));
  const r = await postDispatch(actor, oid(d.id));
  return { id: r.invoice!.id };
}

const sales = (q: Partial<SalesReportQuery>, who = actor) =>
  salesReport(who, { groupBy: 'dealer', ...q } as SalesReportQuery);

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
  const REPORTS: Permission[] = [
    'report:sales',
    'report:stock',
    'report:receivables',
    'report:pos',
    'report:profit',
  ];
  viewer = actorFor(f, REPORTS);
  const other = await Location.create({
    orgId: f.orgId,
    code: 'ZZFAR',
    name: 'ZZTEST Far Shop',
    type: 'COUNTER',
  });
  elsewhere = {
    ...actorFor(f),
    user: { ...actorFor(f).user, locationIds: [String(other._id)] },
  };

  const ws1 = await invoiced(12);
  await invoiced(6);
  const line = String(
    ((await Invoice.findById(ws1.id).lean())!.lines[0] as unknown as { _id: Types.ObjectId })
      ._id,
  );
  await postWholesaleReturn(actor, {
    invoiceId: ws1.id,
    reason: 'DAMAGED',
    settlement: 'CREDIT_NOTE',
    lines: [
      {
        invoiceLineId: line,
        qtyBase: 2,
        condition: 'GOOD',
        restockLocationId: String(f.locationId),
      },
    ],
  });
  await postReceipt(actor, { partyId: f.dealerId, amountMinor: 30_000, method: 'CASH' });
  await postReceipt(actor, {
    partyId: f.dealerId,
    amountMinor: 20_000,
    method: 'BANK',
    reference: 'TT-77',
  });

  const session = await openSession(actor, {
    locationId: String(f.locationId),
    terminalCode: 'T1',
    openingFloatMinor: 100_000,
  });
  await postPosSale(actor, {
    clientRef: randomUUID(),
    paymentMode: 'CASH',
    lines: [{ productId: f.frameId, qty: 1 }],
    tenders: [{ method: 'CASH', amountMinor: 6_000 }],
  });
  await closeSession(actor, oid(session.id), {
    denominations: [
      // ৳1,000 float + ৳60 sale = ৳1,060 in the drawer.
      { note: 1000, count: 1 },
      { note: 50, count: 1 },
      { note: 10, count: 1 },
    ],
  });
}, 240_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('sales', () => {
  it('by dealer: sales net of returns, margin against cost at sale, and it ties', async () => {
    const r = await sales({ groupBy: 'dealer' });
    const dealer = r.rows.find((x) => x.key === f.dealerId)!;
    expect(dealer).toMatchObject({
      invoices: 2,
      qtyBase: 16,
      salesMinor: 108_000,
      returnsMinor: 12_000,
      netMinor: 96_000,
      costMinor: 16 * 3_000,
      marginMinor: 96_000 - 48_000,
      marginPct: 50,
    });
    expect(r.rows.find((x) => x.key === 'walk-in')).toMatchObject({
      qtyBase: 1,
      netMinor: 6_000,
    });
    expect(r.totals.netMinor).toBe(102_000);
    expect(r.ties.every((t) => t.matches)).toBe(true);
  });

  it('by product, channel and day add up to the same net', async () => {
    for (const groupBy of [
      'product',
      'brand',
      'channel',
      'day',
      'month',
      'salesperson',
    ] as const) {
      const r = await sales({ groupBy });
      expect(r.rows.reduce((t, x) => t + x.netMinor, 0)).toBe(102_000);
      expect(r.totals.netMinor).toBe(102_000);
    }
    const byChannel = await sales({ groupBy: 'channel' });
    expect(byChannel.rows.map((x) => [x.key, x.netMinor])).toEqual([
      ['WHOLESALE', 96_000],
      ['COUNTER', 6_000],
    ]);
  });

  it('hides cost and margin without stock:viewCost', async () => {
    const r = await sales({ groupBy: 'product' }, viewer);
    expect(r.costHidden).toBe(true);
    expect(r.rows.every((x) => x.costMinor === null && x.marginMinor === null)).toBe(true);
    expect(r.totals.netMinor).toBe(102_000);
  });

  it('a user tied to another location sees none of it', async () => {
    const r = await sales({ groupBy: 'dealer' }, elsewhere);
    expect(r.rows).toEqual([]);
    expect(r.totals.netMinor).toBe(0);
  });

  it('a period with nothing in it is empty, not an error', async () => {
    const r = await sales({ from: '2001-01-01', to: '2001-01-31' });
    expect(r.rows).toEqual([]);
    expect(r.ties.every((t) => t.matches)).toBe(true);
  });
});

describe('stock valuation and dead stock', () => {
  it('values on-hand stock at the moving average, and its units are the stock ledger’s', async () => {
    const r = await stockValuation(actor, { groupBy: 'product' });
    const frame = r.rows.find((x) => x.productId === f.frameId)!;
    // 60 opening − 18 dispatched + 2 returned − 1 sold at the counter.
    expect(frame).toMatchObject({ qtyOnHand: 43, avgCostMinor: 3_000, valueMinor: 43 * 3_000 });
    expect(r.ties.every((t) => t.matches)).toBe(true);
    const hidden = await stockValuation(viewer, { groupBy: 'product' });
    expect(hidden.costHidden).toBe(true);
    expect(hidden.totals.valueMinor).toBeNull();
    expect((await stockValuation(elsewhere, { groupBy: 'product' })).rows).toEqual([]);
  });

  it('dead stock: the lensmeters never sold; the frames sold today are not dead', async () => {
    const r = await deadStock(actor, { days: 1 });
    expect(r.rows.map((x) => [x.productId, x.daysSinceSale])).toEqual([[f.machineId, null]]);
  });
});

describe('registers and shifts', () => {
  it('dispatch register: two challans, 18 frames, tied to the SALE movements', async () => {
    const r = await dispatchRegister(actor, {});
    expect(r.totals).toMatchObject({ dispatches: 2, qtyBase: 18, invoiceMinor: 108_000 });
    expect(r.ties.every((t) => t.matches)).toBe(true);
    expect((await dispatchRegister(elsewhere, {})).rows).toEqual([]);
  });

  it('collection register: both receipts, by method, tied to the RECEIPT ledger credits', async () => {
    const r = await collectionRegister(actor, {});
    expect(r.totals).toMatchObject({ count: 2, amountMinor: 50_000, pendingChequesMinor: 0 });
    expect(r.byMethod.map((m) => [m.method, m.amountMinor])).toEqual([
      ['CASH', 30_000],
      ['BANK', 20_000],
    ]);
    expect(r.ties.every((t) => t.matches)).toBe(true);
  });

  it('shift summary: the closed shift, its sale, tied to its counter invoices', async () => {
    const r = await shiftSummary(actor, {});
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ salesCount: 1, netMinor: 6_000, varianceMinor: 0 });
    expect(r.ties.every((t) => t.matches)).toBe(true);
    expect((await shiftSummary(elsewhere, {})).rows).toEqual([]);
  });
});

describe('THE DAY 38 DONE-WHEN: every dashboard number matches its report', () => {
  it('sales, receivables, low stock and pending dispatch — each equal to its own report', async () => {
    await Product.updateOne(
      { _id: f.frameId },
      { $set: { reorderPoint: 100, reorderQty: 48 } },
    );
    await createOrder(actor, {
      dealerPartyId: f.dealerId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, qty: 3 }],
    }).then((d) => confirmOrder(actor, oid(d.id), {}));

    const d = await dashboard(actor);
    const today = d.today;
    const todays = await sales({ groupBy: 'channel', from: today, to: today });
    const month = await sales({ groupBy: 'channel', to: today });
    expect(d.sales!.todayNetMinor).toBe(todays.totals.netMinor);
    expect(d.sales!.todayNetMinor).toBe(102_000);
    expect(d.sales!.todayWholesaleMinor + d.sales!.todayCounterMinor).toBe(
      todays.totals.netMinor,
    );
    expect(d.sales!.monthNetMinor).toBe(month.totals.netMinor);

    const daily = await sales({ groupBy: 'day', from: d.sales!.trend[0]!.day, to: today });
    expect(d.sales!.trend).toHaveLength(30);
    expect(d.sales!.trend.reduce((t, x) => t + x.wholesaleMinor + x.counterMinor, 0)).toBe(
      daily.totals.netMinor,
    );
    expect(d.sales!.topDealers[0]).toMatchObject({ partyId: f.dealerId, netMinor: 96_000 });

    const ageing = await ageingReport(actor, {});
    expect(d.receivables!.totalMinor).toBe(ageing.totalMinor);
    expect(d.receivables!.overdueMinor).toBe(ageing.totalMinor - ageing.totals.CURRENT);

    const reorder = await reorderSuggestions(actor, {});
    expect(d.lowStock!.count).toBe(reorder.length);
    expect(d.lowStock!.items.map((i) => i.productId)).toContain(f.frameId);

    const counts = await orderCounts(actor, {});
    expect(d.dispatch!.pendingOrders).toBe(
      counts.byStatus.CONFIRMED +
        counts.byStatus.PICKING +
        counts.byStatus.PACKED +
        counts.byStatus.PARTIALLY_DISPATCHED,
    );
    expect(d.dispatch!.pendingOrders).toBe(1);
  });

  it('a section the caller may not see is left out, not zeroed', async () => {
    const d = await dashboard(viewer); // reports, but no payments, purchasing or orders
    expect(d.sales).not.toBeNull();
    expect(d.receivables).toBeNull();
    expect(d.lowStock).toBeNull();
    expect(d.dispatch).toBeNull();
    const far = await dashboard(elsewhere);
    expect(far.sales!.todayNetMinor).toBe(0);
  });
});
