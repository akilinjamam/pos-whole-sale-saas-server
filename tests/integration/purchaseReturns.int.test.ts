import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { movingAverageOut } from '../../src/domain/costing.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { GoodsReceipt } from '../../src/modules/goodsReceipt/goodsReceipt.model.js';
import {
  createGrn,
  getGrn,
  postGrn,
} from '../../src/modules/goodsReceipt/goodsReceipt.service.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { Product } from '../../src/modules/product/product.model.js';
import { createProduct } from '../../src/modules/product/product.service.js';
import { PurchaseReturn } from '../../src/modules/purchaseReturn/purchaseReturn.model.js';
import {
  createPurchaseReturn,
  listPurchaseReturns,
} from '../../src/modules/purchaseReturn/purchaseReturn.service.js';
import { SerialUnit } from '../../src/modules/serialUnit/serialUnit.model.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import { reorderSuggestions } from '../../src/modules/supplierPo/reorder.service.js';
import {
  approvePo,
  createPo,
  sendPo,
} from '../../src/modules/supplierPo/supplierPo.service.js';
import { ALL_PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { Permission } from '../../src/shared/permissions.js';
import type { GoodsReceiptPayload } from '../../src/shared/types.js';

/**
 * Day 34's server half, against a real replica set in a throwaway org:
 *   - a purchase return against a posted receipt takes the stock out, re-costs what is left,
 *     remembers on the receipt how much went back and debits the supplier — or, refused, none
 *     of it;
 *   - a direct return works without a receipt;
 *   - reorder suggestions count open purchase orders, and not drafts.
 *
 * Received: 1 dozen frames at ৳40 + ৳24 freight, two lensmeters, 24 bottles of solution (lot).
 */

let f: PosFixture;
let manager: RequestActor;
let storekeeper: RequestActor;
let supplierId: string;
let solutionId: string;
let grn: GoodsReceiptPayload;

const STORE: Permission[] = ['grn:read', 'grn:create', 'po:read'];
const oid = (id: string) => new Types.ObjectId(id);

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const shelf = async (productId: string) => {
  const b = await StockBalance.findOne({
    orgId: f.orgId,
    locationId: f.locationId,
    productId: oid(productId),
  }).lean();
  return { onHand: b?.qtyOnHand ?? 0, avg: b?.avgCostMinor ?? 0 };
};
const supplierBalance = async () =>
  (await Party.findById(supplierId).lean())!.currentBalanceMinor;
const grnLine = (productId: string) => grn.lines.find((l) => l.productId === productId)!;

async function footprint() {
  const g = await GoodsReceipt.findById(grn.id).lean();
  return {
    frame: await shelf(f.frameId),
    machine: await shelf(f.machineId),
    solution: await shelf(solutionId),
    frameAvg: (await Product.findById(f.frameId).lean())!.avgCostMinor,
    returned: g!.lines.map((l) => l.qtyReturnedBase),
    supplier: await supplierBalance(),
    ledgerRows: await LedgerEntry.countDocuments({ orgId: f.orgId }),
    stockRows: await StockLedger.countDocuments({ orgId: f.orgId }),
    returns: await PurchaseReturn.countDocuments({ orgId: f.orgId }),
    serials: await SerialUnit.find({ orgId: f.orgId })
      .select('serialNo status')
      .sort('serialNo')
      .lean(),
  };
}

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([PurchaseReturn.syncIndexes(), GoodsReceipt.syncIndexes()]);
  f = await createPosFixture();
  manager = actorFor(f);
  storekeeper = actorFor(f, STORE);
  supplierId = (
    await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'SUPPLIER',
      { name: 'ZZTEST Return Supplier', supplier: { paymentTermsDays: 30 } },
    )
  ).id;
  solutionId = (
    await createProduct(
      f.orgId,
      {
        sku: 'ZZ-SOL',
        name: 'ZZTEST Lens Solution',
        type: 'ACCESSORY',
        baseUom: 'PCS',
        trackingMode: 'LOT',
        defaultSellPriceMinor: 45_000,
        attrs: { volumeMl: 360, requiresExpiry: true, shelfLifeDays: 730 },
      },
      f.userId,
      true,
    )
  ).id;

  const draft = await createPo(manager, {
    supplierPartyId: supplierId,
    locationId: String(f.locationId),
    lines: [
      { productId: f.frameId, uomCode: 'DOZ', qty: 1, unitCostMinor: 48_000 },
      { productId: f.machineId, qty: 2, unitCostMinor: 4_000_000 },
      { productId: solutionId, qty: 24, unitCostMinor: 25_000 },
    ],
  });
  await approvePo(manager, oid(draft.id));
  const po = await sendPo(manager, oid(draft.id));
  const line = (pid: string) => po.lines.find((l) => l.productId === pid)!.id;
  const g = await createGrn(manager, {
    poId: po.id,
    supplierInvoiceNo: 'RS-1',
    lines: [
      { poLineId: line(f.frameId), productId: f.frameId, uomCode: 'DOZ', qty: 1 },
      {
        poLineId: line(f.machineId),
        productId: f.machineId,
        qty: 2,
        serials: ['ZZSN-10', 'ZZSN-11'],
      },
      {
        poLineId: line(solutionId),
        productId: solutionId,
        qty: 24,
        lotNo: 'L-RS1',
        expiryDate: '2028-06-30',
      },
    ],
    otherChargesMinor: 2_400,
  });
  grn = await postGrn(manager, oid(g.id));
}, 180_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('a return against a posted receipt', () => {
  it('stock out, serial RETURNED, receipt remembers, cost re-blended, supplier debited', async () => {
    const before = await footprint();
    const frameCost = { qtyOnHand: before.frame.onHand, avgCostMinor: before.frame.avg };

    const r = await createPurchaseReturn(manager, {
      grnId: grn.id,
      reason: 'DAMAGED',
      note: 'cracked in transit',
      lines: [
        { grnLineNo: grnLine(f.frameId).lineNo, productId: f.frameId, qty: 2 },
        {
          grnLineNo: grnLine(f.machineId).lineNo,
          productId: f.machineId,
          qty: 1,
          serials: ['zzsn-10'],
        },
        // The lot comes from the receipt line when not named.
        { grnLineNo: grnLine(solutionId).lineNo, productId: solutionId, qty: 4 },
      ],
    });

    // Valued at the bill's own net cost, not the landed cost: the supplier keeps the freight.
    expect(r).toMatchObject({
      docNo: expect.stringMatching(/^DN-/),
      grnDocNo: grn.docNo,
      supplierName: 'ZZTEST Return Supplier',
      status: 'POSTED',
      totalMinor: 8_000 + 4_000_000 + 100_000,
    });
    expect(r.lines.map((l) => [l.qtyBase, l.lineTotalMinor, l.lotNo, l.serials])).toEqual([
      [2, 8_000, null, []],
      [1, 4_000_000, null, ['ZZSN-10']],
      [4, 100_000, 'L-RS1', []],
    ]);

    const after = await footprint();
    expect(after.frame.onHand).toBe(before.frame.onHand - 2);
    expect(after.machine.onHand).toBe(before.machine.onHand - 1);
    expect(after.solution.onHand).toBe(before.solution.onHand - 4);
    expect(after.frame.avg).toBe(movingAverageOut(frameCost, 2, 8_000));
    expect(after.frameAvg).toBe(after.frame.avg);
    expect(after.returned).toEqual([2, 1, 4]);
    expect(after.supplier).toBe(before.supplier + 4_108_000);
    expect(after.serials.find((s) => s.serialNo === 'ZZSN-10')!.status).toBe('RETURNED');

    const entry = await LedgerEntry.findOne({ orgId: f.orgId, refId: oid(r.id) }).lean();
    expect(entry).toMatchObject({
      docType: 'DEBIT_NOTE',
      debitMinor: 4_108_000,
      creditMinor: 0,
    });
    const rows = await StockLedger.find({ orgId: f.orgId, refId: oid(r.id) }).lean();
    expect(rows.every((m) => m.movementType === 'PURCHASE_RETURN' && m.qtyBase < 0)).toBe(true);

    // The receipt shows it too.
    expect((await getGrn(manager, oid(grn.id))).lines.map((l) => l.qtyReturnedBase)).toEqual([
      2, 1, 4,
    ]);
  });

  it('never more than is left on the receipt line', async () => {
    const before = await footprint();
    const e = await refusal(
      createPurchaseReturn(manager, {
        grnId: grn.id,
        reason: 'NOT_SOLD',
        lines: [{ grnLineNo: grnLine(f.frameId).lineNo, productId: f.frameId, qty: 11 }],
      }),
    );
    expect(e.status).toBe(422);
    expect(e.details).toEqual([
      { path: 'lines.0.qty', message: expect.stringContaining('has 10 left to return') },
    ]);
    expect(await footprint()).toEqual(before);
  });

  it('only its own serials and its own lot', async () => {
    const e = await refusal(
      createPurchaseReturn(manager, {
        grnId: grn.id,
        reason: 'WARRANTY',
        lines: [
          {
            grnLineNo: grnLine(f.machineId).lineNo,
            productId: f.machineId,
            qty: 1,
            serials: ['ZZSN-1'], // opening stock, not this receipt's
          },
          {
            grnLineNo: grnLine(solutionId).lineNo,
            productId: solutionId,
            qty: 1,
            lotNo: 'OTHER',
          },
          {
            grnLineNo: grnLine(f.frameId).lineNo,
            productId: f.frameId,
            qty: 1,
            unitCostMinor: 1,
          },
        ],
      }),
    );
    expect(e.details).toEqual([
      { path: 'lines.0.serials', message: expect.stringContaining('ZZSN-1') },
      { path: 'lines.1.lotNo', message: expect.stringContaining('L-RS1') },
      { path: 'lines.2.unitCostMinor', message: `The cost comes from ${grn.docNo}` },
    ]);
  });

  it('refused partway — a unit already gone back — and nothing at all moves', async () => {
    const before = await footprint();
    // Passes the receipt checks (ZZSN-10 is on the line, 1 of 2 still returnable), then the
    // stock engine refuses it: it is not in stock. The frame line ahead of it rolls back too.
    await refusal(
      createPurchaseReturn(manager, {
        grnId: grn.id,
        reason: 'DAMAGED',
        lines: [
          { grnLineNo: grnLine(f.frameId).lineNo, productId: f.frameId, qty: 1 },
          {
            grnLineNo: grnLine(f.machineId).lineNo,
            productId: f.machineId,
            qty: 1,
            serials: ['ZZSN-10'],
          },
        ],
      }),
    );
    expect(await footprint()).toEqual(before);
  });
});

describe('a direct return', () => {
  it('a store keeper returns at the current cost without seeing it, and cannot type one', async () => {
    const before = await footprint();
    const typed = await refusal(
      createPurchaseReturn(storekeeper, {
        supplierPartyId: supplierId,
        locationId: String(f.locationId),
        reason: 'WRONG_ITEM',
        lines: [{ productId: f.frameId, qty: 3, unitCostMinor: 1_000 }],
      }),
    );
    expect(typed.details).toEqual([
      { path: 'lines.0.unitCostMinor', message: 'You need stock:viewCost to enter a cost' },
    ]);

    const r = await createPurchaseReturn(storekeeper, {
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      reason: 'WRONG_ITEM',
      lines: [{ productId: f.frameId, qty: 3 }],
    });
    expect(r).toMatchObject({ grnId: null, costHidden: true, totalMinor: null });
    expect(r.lines[0]).toMatchObject({ unitCostMinor: null, grnLineNo: null });

    const after = await footprint();
    expect(after.frame.onHand).toBe(before.frame.onHand - 3);
    // At the average, so the average stands.
    expect(after.frame.avg).toBe(before.frame.avg);
    expect(after.supplier).toBe(before.supplier + 3 * before.frame.avg);
  });

  it('the list, newest first, hides costs from the store keeper', async () => {
    const { items } = await listPurchaseReturns(storekeeper, {
      page: 1,
      limit: 10,
      order: 'desc',
    });
    expect(items).toHaveLength(2);
    expect(items.every((r) => r.totalMinor === null)).toBe(true);
    const mine = await listPurchaseReturns(manager, {
      page: 1,
      limit: 10,
      order: 'desc',
      grnId: grn.id,
    });
    expect(mine.items.map((r) => r.grnDocNo)).toEqual([grn.docNo]);
  });
});

describe('reorder suggestions', () => {
  it('below the point, net of open POs and not of drafts', async () => {
    const onHand = (await shelf(f.frameId)).onHand;
    await Product.updateOne(
      { _id: f.frameId },
      { $set: { reorderPoint: onHand + 30, reorderQty: 50 } },
    );

    let [s] = await reorderSuggestions(manager, {});
    expect(s).toMatchObject({
      productId: f.frameId,
      onHandBase: onHand,
      onOrderBase: 0,
      suggestedBase: 50,
      lastSupplierName: 'ZZTEST Return Supplier',
    });

    // A draft for 2 dozen counts for nothing; approved, it counts.
    const draft = await createPo(manager, {
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 2 }],
    });
    [s] = await reorderSuggestions(manager, {});
    expect(s!.onOrderBase).toBe(0);
    await approvePo(manager, oid(draft.id));
    [s] = await reorderSuggestions(manager, {});
    expect(s).toMatchObject({ onOrderBase: 24, positionBase: onHand + 24, suggestedBase: 50 });

    // Enough on order to clear the point: no longer suggested.
    await Product.updateOne({ _id: f.frameId }, { $set: { reorderPoint: onHand + 24 } });
    expect(await reorderSuggestions(manager, {})).toEqual([]);
  });

  it('a store keeper sees no cost', async () => {
    await Product.updateOne({ _id: f.frameId }, { $set: { reorderPoint: 10_000 } });
    const [s] = await reorderSuggestions(storekeeper, {});
    expect(s!.avgCostMinor).toBeNull();
    expect(s!.suggestedBase).toBe(10_000 - s!.positionBase);
  });
});
