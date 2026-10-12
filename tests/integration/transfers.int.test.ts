import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { createGrn, postGrn } from '../../src/modules/goodsReceipt/goodsReceipt.service.js';
import { Location } from '../../src/modules/location/location.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { createProduct } from '../../src/modules/product/product.service.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import {
  createTransfer,
  postTransfer,
  receiveTransfer,
} from '../../src/modules/stockTransfer/stockTransfer.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';

/**
 * A transfer moves value with the goods: both legs are valued at the item's one moving average,
 * and a location that has never held the item gets that average on its new balance row — not
 * the schema default of 0, which Stock on hand shows as no cost at all.
 */

let f: PosFixture;
let actor: RequestActor;
let warehouse: Types.ObjectId;
let shop: Types.ObjectId;
let transit: Types.ObjectId;
let frameId: string;
const oid = (id: string) => new Types.ObjectId(id);
const UNIT_COST = 30_000; // ৳300 a piece

const balance = async (loc: Types.ObjectId) =>
  StockBalance.findOne({ orgId: f.orgId, locationId: loc, productId: oid(frameId) }).lean();
const legs = (refId: string) =>
  StockLedger.find({ orgId: f.orgId, productId: oid(frameId), refId: oid(refId) })
    .sort({ _id: 1 })
    .lean();

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
  const loc = async (code: string, type: 'WAREHOUSE' | 'TRANSIT') =>
    (
      await Location.create({
        orgId: f.orgId,
        code,
        name: `ZZTEST ${code}`,
        type,
        allowsPurchase: type === 'WAREHOUSE',
      })
    )._id;
  warehouse = await loc('WH-T', 'WAREHOUSE');
  transit = await loc('TR-T', 'TRANSIT');
  // The fixture's own counter is the shop.
  shop = f.locationId;

  frameId = (
    await createProduct(
      f.orgId,
      {
        sku: 'ZZ-TRF-FRM',
        name: 'ZZTEST Transfer Frame',
        type: 'FRAME',
        baseUom: 'PCS',
        defaultSellPriceMinor: 70_000,
        standardCostMinor: UNIT_COST,
        attrs: { polarized: false, uvProtection: false, hasCase: false },
      },
      f.userId,
      true,
    )
  ).id;
  const supplier = await createParty(
    { orgId: f.orgId, actorId: f.userId, permissions: actor.user.permissions },
    'SUPPLIER',
    { name: 'ZZTEST Transfer Supplier' },
  );
  const g = await createGrn(actor, {
    supplierPartyId: supplier.id,
    locationId: String(warehouse),
    supplierInvoiceNo: 'TRF-1',
    lines: [{ productId: frameId, qty: 50, unitCostMinor: UNIT_COST }],
  });
  await postGrn(actor, oid(g.id));
}, 180_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('transfers carry cost', () => {
  it('direct: the new shop row takes the average, and both legs are valued', async () => {
    const avg = (await balance(warehouse))!.avgCostMinor;
    expect(avg).toBe(UNIT_COST);
    expect(await balance(shop)).toBeNull();

    const t = await createTransfer(actor, {
      fromLocationId: String(warehouse),
      toLocationId: String(shop),
      lines: [{ productId: frameId, qty: 10 }],
    });
    await postTransfer(actor, oid(t.id));

    expect((await balance(shop))!).toMatchObject({ qtyOnHand: 10, avgCostMinor: avg });
    expect((await balance(warehouse))!).toMatchObject({ qtyOnHand: 40, avgCostMinor: avg });
    expect((await legs(t.id)).map((l) => [l.movementType, l.unitCostMinor, l.valueMinor])).toEqual(
      [
        ['TRANSFER_OUT', avg, -10 * avg],
        ['TRANSFER_IN', avg, 10 * avg],
      ],
    );
  });

  it('via transit: both legs of both hops are valued, and the shop keeps the average', async () => {
    const t = await createTransfer(actor, {
      fromLocationId: String(warehouse),
      toLocationId: String(shop),
      transitLocationId: String(transit),
      lines: [{ productId: frameId, qty: 5 }],
    });
    await postTransfer(actor, oid(t.id));
    expect((await balance(transit))!).toMatchObject({ qtyOnHand: 5, avgCostMinor: UNIT_COST });

    await receiveTransfer(actor, oid(t.id));
    expect((await balance(shop))!).toMatchObject({ qtyOnHand: 15, avgCostMinor: UNIT_COST });
    const rows = await legs(t.id);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.valueMinor).toBe(r.qtyBase * UNIT_COST);
  });
});
