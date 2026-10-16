import { randomUUID } from 'node:crypto';

import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { login } from '../../src/modules/auth/auth.service.js';
import { Brand } from '../../src/modules/brand/brand.model.js';
import { Category } from '../../src/modules/category/category.model.js';
import { Dispatch } from '../../src/modules/dispatch/dispatch.model.js';
import { GoodsReceipt } from '../../src/modules/goodsReceipt/goodsReceipt.model.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { Location } from '../../src/modules/location/location.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { Party } from '../../src/modules/party/party.model.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import { HeldSale } from '../../src/modules/pos/heldSale.model.js';
import { PosSession } from '../../src/modules/pos/posSession.model.js';
import { openSession } from '../../src/modules/pos/posSession.service.js';
import { PriceListEntry } from '../../src/modules/priceList/priceList.model.js';
import { createPriceEntry } from '../../src/modules/priceList/priceList.service.js';
import { PriceTier } from '../../src/modules/priceTier/priceTier.model.js';
import { resolveForRequest } from '../../src/modules/pricing/pricing.service.js';
import { Product } from '../../src/modules/product/product.model.js';
import { createProduct } from '../../src/modules/product/product.service.js';
import { PurchaseReturn } from '../../src/modules/purchaseReturn/purchaseReturn.model.js';
import { Role } from '../../src/modules/role/role.model.js';
import { CreditNote } from '../../src/modules/salesReturn/creditNote.model.js';
import { SalesReturn } from '../../src/modules/salesReturn/salesReturn.model.js';
import { StockAdjustment } from '../../src/modules/stockAdjustment/stockAdjustment.model.js';
import { createAdjustment } from '../../src/modules/stockAdjustment/stockAdjustment.service.js';
import { StockCount } from '../../src/modules/stockCount/stockCount.model.js';
import { StockTransfer } from '../../src/modules/stockTransfer/stockTransfer.model.js';
import { createTransfer } from '../../src/modules/stockTransfer/stockTransfer.service.js';
import { PurchaseOrder } from '../../src/modules/supplierPo/purchaseOrder.model.js';
import { User } from '../../src/modules/user/user.model.js';
import { createUser } from '../../src/modules/user/user.service.js';
import { Variant } from '../../src/modules/variant/variant.model.js';
import { WholesaleOrder } from '../../src/modules/wholesaleOrder/wholesaleOrder.model.js';
import { createOrder } from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { allRoutes } from '../../src/routes/index.js';
import { provisionOrg } from '../../src/services/provisioning.service.js';
import { postMovements } from '../../src/services/stock.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { ProvisionedOrg } from '../../src/services/provisioning.service.js';
import type { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * SaaS phase 2 — proof that one business cannot reach another's data.
 *
 * Business A holds real data (the POS fixture) plus one document in every collection an `/:id`
 * route reads. Business B's owner — who holds every permission, and has a shift open so the
 * counter routes reach their lookups — then, over real HTTP:
 *
 *  1. calls **every** route that takes a path parameter with one of A's ids, and again with an id
 *     that exists nowhere. The two answers must be identical, and neither may succeed: A's
 *     document must be indistinguishable from no document at all.
 *  2. calls every list route, plain and with A's ids as filters. No response may carry A's data.
 *  3. creates documents that point at A's dealer, product, location, tier or role. Each is run
 *     first with B's own ids (it must succeed — otherwise the refusal would prove nothing) and
 *     then with one id swapped for A's (it must be refused).
 *
 * Finally every document A owns must be byte-for-byte what it was before B started.
 *
 * The route walk is mechanical, like `tests/routeCoverage.test.ts`: a new route with a path
 * parameter fails this file until it is mapped below, so isolation cannot be forgotten.
 */

// ─── Which collection each `/:id` route reads ───────────────────────────────────────────

/** Keyed by the route path before `/:id`. A new parameterised route must be added here. */
const ID_ROUTE_MODELS: Record<string, mongoose.Model<never>> = {
  locations: Location as never,
  roles: Role as never,
  users: User as never,
  brands: Brand as never,
  categories: Category as never,
  products: Product as never,
  variants: Variant as never,
  dealers: Party as never,
  customers: Party as never,
  suppliers: Party as never,
  'price-tiers': PriceTier as never,
  'price-lists': PriceListEntry as never,
  'stock-adjustments': StockAdjustment as never,
  'stock-transfers': StockTransfer as never,
  'stock-counts': StockCount as never,
  'pos/sessions': PosSession as never,
  'pos/sales': Invoice as never,
  'pos/returns': SalesReturn as never,
  'pos/held': HeldSale as never,
  orders: WholesaleOrder as never,
  dispatches: Dispatch as never,
  invoices: Invoice as never,
  'payments/receipts': PaymentDoc as never,
  'payments/supplier-payments': PaymentDoc as never,
  'payments/cheques': PaymentDoc as never,
  'purchase-orders': PurchaseOrder as never,
  'goods-receipts': GoodsReceipt as never,
  'purchase-returns': PurchaseReturn as never,
  'sales-returns/invoice': Invoice as never,
  'sales-returns': SalesReturn as never,
  'credit-notes': CreditNote as never,
};

/**
 * Parameterised routes whose parameter is not one of A's ids, with the reason they are safe.
 * Keep it argued, as in routeCoverage.test.ts.
 */
const NOT_AN_ID: Record<string, string> = {
  'number-series/:series':
    'The series code (INV, ORD, …) names one of the caller’s own series; every business has the ' +
    'same codes, so there is no foreign id to pass. The service filters by the caller’s orgId.',
};

/** List routes whose response is the caller's own identity, not business data. */
const SKIP_LISTS = new Set(['health', 'auth/me', 'auth/me/locations']);

// ─── Route walking ──────────────────────────────────────────────────────────────────────

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

interface Endpoint {
  method: string;
  /** e.g. `orders/:id/confirm` */
  key: string;
}

function endpoints(): Endpoint[] {
  return allRoutes.flatMap(({ path, route }) =>
    (route as Router & { stack: Layer[] }).stack.flatMap((layer) => {
      if (!layer.route) return [];
      const sub = layer.route.path === '/' ? '' : layer.route.path;
      return Object.keys(layer.route.methods).map((m) => ({
        method: m.toUpperCase(),
        key: `${path}${sub}`,
      }));
    }),
  );
}

// ─── State ──────────────────────────────────────────────────────────────────────────────

const run = randomUUID().slice(0, 8);
const PASSWORD = 'Test1234!';

let a: PosFixture;
let b: ProvisionedOrg;
let actorB: RequestActor;
let server: Server;
let base: string;
let tokenB: string;

/** One of A's ids per collection — real where the fixture made one, a decoy otherwise. */
const idOfA = new Map<string, Types.ObjectId>();
const A_BARCODE = `ZZBC-A-${run}`;
/** Strings that exist only in A's data; none may appear in anything B is sent. */
let markersOfA: string[] = [];
let snapshotBefore = '';

/** Everything A owns, in a stable order, for the before/after comparison. */
async function snapshotOfA(): Promise<string> {
  const db = mongoose.connection.db!;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();
  const parts: string[] = [];
  for (const name of names) {
    const filter =
      name === 'orgs'
        ? { _id: a.orgId }
        : name === 'counters'
          ? { _id: { $regex: `^${String(a.orgId)}:` } }
          : { orgId: a.orgId };
    const docs = await db
      .collection(name)
      .find(filter as never)
      .sort({ _id: 1 })
      .toArray();
    if (docs.length > 0) parts.push(`${name}:${JSON.stringify(docs)}`);
  }
  return parts.join('\n');
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokenB}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').toBeInstanceOf(ApiError);
  return err as ApiError;
}

// ─── Setup ──────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await connectDatabase();

  // A: real counter data, a barcode to look up, and a decoy in every collection still empty.
  a = await createPosFixture();
  await Product.updateOne({ _id: a.frameId }, { $set: { barcode: A_BARCODE } });

  const models = [...new Set(Object.values(ID_ROUTE_MODELS))];
  for (const [i, model] of models.entries()) {
    const existing = await model.findOne({ orgId: a.orgId }).select('_id').lean<{ _id: Types.ObjectId }>();
    if (existing) {
      idOfA.set(model.collection.name, existing._id);
      continue;
    }
    const _id = new Types.ObjectId();
    const now = new Date();
    await model.collection.insertOne({
      _id,
      orgId: a.orgId,
      name: `ZZTEST-A decoy ${run}`,
      code: `ZZDECOY${i}`,
      docNo: `ZZ-DECOY-${run}-${i}`,
      email: `zztest-decoy-${run}-${i}@example.invalid`,
      status: 'DRAFT',
      isActive: true,
      isDeleted: false,
      lines: [],
      createdAt: now,
      updatedAt: now,
    });
    idOfA.set(model.collection.name, _id);
  }

  // B: a freshly signed-up business, and its owner's token.
  b = await withTransaction((session) =>
    provisionOrg(
      {
        business: { name: `ZZTEST Isolation B ${run}` },
        owner: {
          name: 'Owner B',
          email: `zztest-iso-b-${run}@example.invalid`,
          password: PASSWORD,
        },
        status: 'ACTIVE',
        signupSource: 'PLATFORM',
      },
      session,
    ),
  );
  actorB = actorFor({ orgId: b.orgId, userId: b.ownerUserId });
  tokenB = (await login({ email: `zztest-iso-b-${run}@example.invalid`, password: PASSWORD }))
    .accessToken;
  // Counter routes refuse anything without an open shift — before they look anything up.
  const shopB = await Location.findOne({ orgId: b.orgId, code: 'SHOP' }).lean();
  await openSession(actorB, {
    locationId: String(shopB!._id),
    terminalCode: 'T1',
    openingFloatMinor: 0,
  });

  const server_ = createApp().listen(0);
  await new Promise<void>((resolve) => server_.once('listening', () => resolve()));
  server = server_;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  // Every id A owns, plus the strings only A's data contains.
  const db = mongoose.connection.db!;
  const ids: string[] = [];
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    const docs = await db
      .collection(name)
      .find({ orgId: a.orgId } as never)
      .project({ _id: 1 })
      .toArray();
    ids.push(...docs.map((d) => String(d._id)));
  }
  markersOfA = [
    ...ids,
    String(a.orgId),
    'ZZ-FRM',
    'ZZ-MCH',
    'ZZSN-1',
    'ZZTEST Rahman Optics',
    A_BARCODE,
    `ZZTEST-A decoy ${run}`,
  ];

  snapshotBefore = await snapshotOfA();
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (a) await cleanupOrg(a.orgId);
  if (b) await cleanupOrg(b.orgId);
  await disconnectDatabase();
});

// ─── 1. Every parameterised route, with A's ids ─────────────────────────────────────────

describe('B calling routes with A’s ids', () => {
  it('every parameterised route is mapped (or exempted with a reason)', () => {
    const unmapped = endpoints()
      .filter((e) => e.key.includes('/:'))
      .filter((e) => !(e.key in NOT_AN_ID))
      .filter((e) => {
        const prefix = e.key.slice(0, e.key.indexOf('/:'));
        const param = e.key.slice(e.key.indexOf('/:') + 2).split('/')[0];
        return !(param === 'id' && prefix in ID_ROUTE_MODELS) && !['code', 'serialNo'].includes(param!);
      })
      .map((e) => `${e.method} ${e.key}`);
    expect(
      unmapped,
      `Map these in ID_ROUTE_MODELS (or NOT_AN_ID, with a reason):\n  ${unmapped.join('\n  ')}`,
    ).toEqual([]);
  });

  it('A’s ids get exactly the answer a non-existent id gets', async () => {
    const failures: string[] = [];
    let notFound = 0;

    /** The answer without its request id, and with the probed value replaced by a placeholder. */
    const answer = (status: number, text: string, probe: string) =>
      `${status} ${text.replaceAll(probe, '<probe>').replace(/"requestId":"[^"]*"/, '')}`;

    for (const e of endpoints().filter((x) => x.key.includes('/:') && !(x.key in NOT_AN_ID))) {
      const prefix = e.key.slice(0, e.key.indexOf('/:'));
      const param = e.key.slice(e.key.indexOf('/:') + 2).split('/')[0]!;
      const ofA =
        param === 'code'
          ? A_BARCODE
          : param === 'serialNo'
            ? 'ZZSN-1'
            : String(idOfA.get(ID_ROUTE_MODELS[prefix]!.collection.name));
      const nowhere =
        param === 'id' ? new Types.ObjectId().toHexString() : `ZZ-NOWHERE-${randomUUID().slice(0, 8)}`;

      const body = e.method === 'GET' ? undefined : {};
      const withA = await call(e.method, e.key.replace(`:${param}`, ofA), body);
      const withNothing = await call(e.method, e.key.replace(`:${param}`, nowhere), body);

      const sig = `${e.method} ${e.key.replace(`:${param}`, ofA)}`;
      if (withA.status < 300) {
        failures.push(`${sig} → ${withA.status} SUCCEEDED: ${withA.text.slice(0, 160)}`);
      } else if (answer(withA.status, withA.text, ofA) !== answer(withNothing.status, withNothing.text, nowhere)) {
        failures.push(
          `${sig} → answers differently from a non-existent id:\n` +
            `      A's id:  ${answer(withA.status, withA.text, ofA).slice(0, 200)}\n` +
            `      nowhere: ${answer(withNothing.status, withNothing.text, nowhere).slice(0, 200)}`,
        );
      }
      if (withA.status === 404) notFound += 1;
    }

    expect(failures, failures.join('\n')).toEqual([]);
    // Most routes must actually reach their lookup — a walk where everything failed validation
    // first would pass the comparison while proving nothing.
    expect(notFound).toBeGreaterThan(60);
  }, 600_000);
});

// ─── 2. Every list route ────────────────────────────────────────────────────────────────

describe('B’s lists', () => {
  it('never contain A’s data — plain, or filtered by A’s ids', async () => {
    const lists = endpoints().filter(
      (e) => e.method === 'GET' && !e.key.includes('/:') && !SKIP_LISTS.has(e.key),
    );
    expect(lists.length).toBeGreaterThan(40);

    const filters = new URLSearchParams({
      productId: a.frameId,
      partyId: a.dealerId,
      dealerPartyId: a.dealerId,
      supplierPartyId: a.dealerId,
      locationId: String(a.locationId),
    });
    const sent = new Set(filters.values());

    const leaks: string[] = [];
    for (const e of lists) {
      for (const query of ['', `?${filters.toString()}`]) {
        const { status, text } = await call('GET', `${e.key}${query}`);
        if (status >= 300) continue; // refused — nothing returned
        // An id B itself sent may be echoed back (in `meta` or a filter summary); that is not A's
        // data. Anything else of A's is.
        const found = markersOfA.filter((m) => !sent.has(m) && text.includes(m));
        if (found.length > 0) leaks.push(`GET ${e.key}${query} → contains ${found.join(', ')}`);
      }
    }

    expect(leaks, leaks.join('\n')).toEqual([]);
  }, 600_000);
});

// ─── 3. Documents that point at A's records ─────────────────────────────────────────────

describe('B creating documents that reference A’s records', () => {
  let productB: string;
  let dealerB: string;
  let mainB: string;
  let shopB: string;
  let tierB: string;

  beforeAll(async () => {
    const product = await createProduct(
      b.orgId,
      {
        sku: `ZZB-FRM-${run}`,
        name: 'ZZTEST B frame',
        type: 'FRAME',
        baseUom: 'PCS',
        packs: [],
        defaultSellPriceMinor: 5_000,
        attrs: { polarized: false, uvProtection: false, hasCase: false },
      },
      b.ownerUserId,
      true,
    );
    productB = product.id;
    const dealer = await createParty(
      { orgId: b.orgId, actorId: b.ownerUserId, permissions: actorB.user.permissions },
      'DEALER',
      { name: 'ZZTEST B dealer', dealer: { creditLimitMinor: 10_000_000, paymentTermsDays: 30 } },
    );
    dealerB = dealer.id;
    const locations = await Location.find({ orgId: b.orgId }).lean();
    mainB = String(locations.find((l) => l.code === 'MAIN')!._id);
    shopB = String(locations.find((l) => l.code === 'SHOP')!._id);
    tierB = String((await PriceTier.findOne({ orgId: b.orgId, code: 'RETAIL' }).lean())!._id);
  }, 120_000);

  it('an order: A’s dealer, product or warehouse is refused', async () => {
    const order = { dealerPartyId: dealerB, locationId: mainB, lines: [{ productId: productB, qty: 1 }] };
    await expect(createOrder(actorB, order)).resolves.toBeTruthy();

    for (const swapped of [
      { ...order, dealerPartyId: a.dealerId },
      { ...order, locationId: String(a.locationId) },
      { ...order, lines: [{ productId: a.frameId, qty: 1 }] },
    ]) {
      expect([404, 422]).toContain((await refusal(createOrder(actorB, swapped))).status);
    }
  });

  it('a transfer: A’s location or product is refused', async () => {
    const transfer = { fromLocationId: mainB, toLocationId: shopB, lines: [{ productId: productB, qty: 1 }] };
    await expect(createTransfer(actorB, transfer)).resolves.toBeTruthy();

    for (const swapped of [
      { ...transfer, toLocationId: String(a.locationId) },
      { ...transfer, lines: [{ productId: a.frameId, qty: 1 }] },
    ]) {
      expect([404, 422]).toContain((await refusal(createTransfer(actorB, swapped))).status);
    }
  });

  it('an adjustment: A’s location or product is refused', async () => {
    const adjustment = {
      locationId: mainB,
      reason: 'DAMAGED' as const,
      lines: [{ productId: productB, qty: -1 }],
    };
    await expect(createAdjustment(actorB, adjustment)).resolves.toBeTruthy();

    for (const swapped of [
      { ...adjustment, locationId: String(a.locationId) },
      { ...adjustment, lines: [{ productId: a.frameId, qty: -1 }] },
    ]) {
      expect([404, 422]).toContain((await refusal(createAdjustment(actorB, swapped))).status);
    }
  });

  it('a price entry: A’s product or tier is refused', async () => {
    const entry = { tierId: tierB, productId: productB, uomCode: 'PCS', priceMinor: 4_500 };
    await expect(createPriceEntry(b.orgId, entry, b.ownerUserId)).resolves.toBeTruthy();

    for (const swapped of [
      { ...entry, productId: a.frameId, priceMinor: 4_600 },
      { ...entry, tierId: String(idOfA.get(PriceTier.collection.name)), priceMinor: 4_700 },
    ]) {
      expect([404, 422]).toContain(
        (await refusal(createPriceEntry(b.orgId, swapped, b.ownerUserId))).status,
      );
    }
  });

  it('a user: A’s role is refused', async () => {
    const user = (email: string, roleId: string) => ({
      name: 'ZZTEST B staff',
      email,
      password: PASSWORD,
      roleIds: [roleId],
      permissionGrants: [],
      permissionRevokes: [],
      locationIds: [],
    });
    await expect(
      createUser(
        b.orgId,
        user(`zztest-iso-b2-${run}@example.invalid`, String(b.roleIds.get('SALES_REP'))),
        b.ownerUserId,
      ),
    ).resolves.toBeTruthy();

    const err = await refusal(
      createUser(
        b.orgId,
        user(`zztest-iso-b3-${run}@example.invalid`, String(idOfA.get(Role.collection.name))),
        b.ownerUserId,
      ),
    );
    expect([404, 422]).toContain(err.status);
  });

  it('pricing: A’s product cannot be priced by B', async () => {
    await expect(resolveForRequest(b.orgId, { productId: productB, qty: 1 } as never)).resolves.toBeTruthy();
    const err = await refusal(resolveForRequest(b.orgId, { productId: a.frameId, qty: 1 } as never));
    expect([404, 422]).toContain(err.status);
  });

  it('stock: B cannot move A’s product, or move anything at A’s location', async () => {
    const move = (productId: string, locationId: string) =>
      withTransaction((session) =>
        postMovements(session, {
          orgId: b.orgId,
          postedAt: new Date(),
          actorId: b.ownerUserId,
          movements: [
            {
              locationId: new Types.ObjectId(locationId),
              productId: new Types.ObjectId(productId),
              variantId: null,
              qtyBase: 5,
              movementType: 'OPENING',
              refType: 'ZZTEST',
              unitCostMinor: 1_000,
            },
          ],
        }),
      );
    await expect(move(productB, mainB)).resolves.toBeTruthy();
    expect((await refusal(move(a.frameId, mainB))).status).toBe(422);
    expect((await refusal(move(productB, String(a.locationId)))).status).toBe(422);
  });
});

// ─── 4. A is untouched ──────────────────────────────────────────────────────────────────

describe('after everything B tried', () => {
  it('every document A owns is exactly as it was', async () => {
    expect(await snapshotOfA()).toBe(snapshotBefore);
  });
});
