import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { SYSTEM_ROLES } from '../../src/db/seed/roles.js';
import { AuditLog } from '../../src/modules/audit/auditLog.model.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { createGrn, postGrn } from '../../src/modules/goodsReceipt/goodsReceipt.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { partyStatement, reconcileLedger } from '../../src/modules/ledger/ledger.service.js';
import { Location } from '../../src/modules/location/location.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { ageingReport } from '../../src/modules/payment/ageing.service.js';
import { allocationPreview, postReceipt } from '../../src/modules/payment/receipt.service.js';
import { postPosSale } from '../../src/modules/pos/posSale.service.js';
import { openSession } from '../../src/modules/pos/posSession.service.js';
import { createPriceEntry } from '../../src/modules/priceList/priceList.service.js';
import { createPriceTier } from '../../src/modules/priceTier/priceTier.service.js';
import { createProduct } from '../../src/modules/product/product.service.js';
import { postWholesaleReturn } from '../../src/modules/salesReturn/salesReturn.service.js';
import { reconcileStock } from '../../src/modules/stock/reconcile.service.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import {
  createTransfer,
  postTransfer,
} from '../../src/modules/stockTransfer/stockTransfer.service.js';
import {
  approveOrder,
  confirmOrder,
  createOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';
import { ALL_PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { SystemRoleCode } from '../../src/db/seed/roles.js';

/**
 * Day 40 — the go-live acceptance walk-through (PROJECT-PLAN §12), all ten steps in order, each as
 * the role the plan names, with that role's real permissions from the seed. Step 1 (what the
 * store keeper's *screen* shows) is a browser check; its server half — the refusal — is here.
 *
 * Fresh goods for the walk: a frame, packed in dozens, with no stock anywhere until step 2.
 */

let f: PosFixture;
const as: Record<string, RequestActor> = {};
let warehouseA: Types.ObjectId;
let damageRoom: Types.ObjectId;
let frameId: string;
let dealerId: string;
let supplierId: string;
let orderId: string;
let invoiceId: string;
const oid = (id: string) => new Types.ObjectId(id);
const DOZEN_PRICE = 600_000; // ৳6,000 a dozen on tier DEALER_A

const role = (code: SystemRoleCode) =>
  actorFor(f, SYSTEM_ROLES.find((r) => r.code === code)!.permissions);
const balance = async (loc: Types.ObjectId) =>
  (await StockBalance.findOne({
    orgId: f.orgId,
    locationId: loc,
    productId: oid(frameId),
  }).lean()) ?? {
    qtyOnHand: 0,
    qtyReserved: 0,
  };
const dealerBalance = async () => (await Party.findById(dealerId).lean())!.currentBalanceMinor;

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  for (const code of [
    'STORE_KEEPER',
    'POS_CASHIER',
    'SALES_REP',
    'SALES_MANAGER',
    'ACCOUNTS',
  ] as const) {
    as[code] = role(code);
  }
  warehouseA = (
    await Location.create({
      orgId: f.orgId,
      code: 'WH-A',
      name: 'Warehouse A',
      type: 'WAREHOUSE',
      allowsPurchase: true,
    })
  )._id;
  damageRoom = (
    await Location.create({ orgId: f.orgId, code: 'DMG', name: 'Damage room', type: 'DAMAGE' })
  )._id;
  frameId = (
    await createProduct(
      f.orgId,
      {
        sku: 'ZZ-ACC-FRM',
        name: 'ZZTEST Acceptance Frame',
        type: 'FRAME',
        baseUom: 'PCS',
        packs: [{ code: 'DOZ', name: 'Dozen', factor: 12, barcode: null }],
        defaultSellPriceMinor: 70_000,
        standardCostMinor: 30_000,
        attrs: { polarized: false, uvProtection: false, hasCase: false },
      },
      f.userId,
      true,
    )
  ).id;
  supplierId = (
    await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'SUPPLIER',
      {
        name: 'ZZTEST Frame Importer',
      },
    )
  ).id;
}, 180_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('Go-live acceptance walk-through', () => {
  it('1. a store keeper cannot reach receivables', () => {
    // The screen half (no Receivables in the sidebar, the URL blocked before any request) is the
    // browser walk-through's; here: the permission the receipts API demands is not theirs.
    expect(as.STORE_KEEPER!.user.permissions).not.toContain('payment:read');
    expect(as.STORE_KEEPER!.user.permissions).not.toContain('payment:receipt');
  });

  it('2. 10 dozen received into Warehouse A: 120 pieces, one GRN row of +120', async () => {
    const g = await createGrn(as.STORE_KEEPER!, {
      supplierPartyId: supplierId,
      locationId: String(warehouseA),
      supplierInvoiceNo: 'ACC-1',
      lines: [{ productId: frameId, uomCode: 'DOZ', qty: 10 }],
    });
    const posted = await postGrn(as.STORE_KEEPER!, oid(g.id));
    expect((await balance(warehouseA)).qtyOnHand).toBe(120);
    const rows = await StockLedger.find({ orgId: f.orgId, productId: oid(frameId) }).lean();
    expect(rows.map((r) => [r.movementType, r.qtyBase, r.refDocNo])).toEqual([
      ['GRN', 120, posted.docNo],
    ]);
  });

  it('3. 2 dozen to the counter: both legs, both balances', async () => {
    const t = await createTransfer(as.STORE_KEEPER!, {
      fromLocationId: String(warehouseA),
      toLocationId: String(f.locationId),
      lines: [{ productId: frameId, uomCode: 'DOZ', qty: 2 }],
    });
    await postTransfer(as.STORE_KEEPER!, oid(t.id));
    expect((await balance(warehouseA)).qtyOnHand).toBe(96);
    expect((await balance(f.locationId)).qtyOnHand).toBe(24);
    const legs = await StockLedger.find({
      orgId: f.orgId,
      productId: oid(frameId),
      refId: oid(t.id),
    }).lean();
    expect(legs.map((l) => [l.movementType, l.qtyBase]).sort()).toEqual([
      ['TRANSFER_IN', 24],
      ['TRANSFER_OUT', -24],
    ]);
  });

  it('4. one frame sold at the counter for cash: counter stock 23, the POS series moves on', async () => {
    await openSession(as.POS_CASHIER!, {
      locationId: String(f.locationId),
      terminalCode: 'T1',
      openingFloatMinor: 0,
    });
    const sell = () =>
      postPosSale(as.POS_CASHIER!, {
        clientRef: randomUUID(),
        paymentMode: 'CASH',
        lines: [{ productId: frameId, qty: 1 }],
        tenders: [{ method: 'CASH', amountMinor: 70_000 }],
      });
    const first = await sell();
    expect(first.invoice.docNo).toMatch(/^POS-/);
    expect((await balance(f.locationId)).qtyOnHand).toBe(23);
    // The series increments: the next number is the one after.
    const n = Number(first.invoice.docNo!.split('-').pop());
    expect(await Invoice.countDocuments({ orgId: f.orgId, series: 'POS' })).toBe(1);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('5. a dealer with a ৳50,000 limit on DEALER_A: 5 dozen priced per dozen from the tier, 60 reserved', async () => {
    const tier = await createPriceTier(
      f.orgId,
      { code: 'DEALER_A', name: 'Dealer A' },
      f.userId,
    );
    await createPriceEntry(
      f.orgId,
      { tierId: tier.id, productId: frameId, uomCode: 'DOZ', priceMinor: DOZEN_PRICE },
      f.userId,
    );
    dealerId = (
      await createParty(
        { orgId: f.orgId, actorId: f.userId, permissions: as.SALES_MANAGER!.user.permissions },
        'DEALER',
        {
          name: 'ZZTEST Acceptance Optics',
          dealer: { priceTierId: tier.id, creditLimitMinor: 5_000_000, paymentTermsDays: 30 },
        },
      )
    ).id;
    const draft = await createOrder(as.SALES_REP!, {
      dealerPartyId: dealerId,
      locationId: String(warehouseA),
      lines: [{ productId: frameId, uomCode: 'DOZ', qty: 5 }],
    });
    expect(draft.lines[0]).toMatchObject({ uomCode: 'DOZ', unitPriceMinor: DOZEN_PRICE });
    const order = await confirmOrder(as.SALES_REP!, oid(draft.id), {});
    expect(order.status).toBe('CONFIRMED');
    orderId = order.id;
    const b = await balance(warehouseA);
    expect(b.qtyReserved).toBe(60);
    expect(b.qtyOnHand - b.qtyReserved).toBe(36); // 96 on hand − 60 promised
  });

  it('6. 3 dozen dispatched: challan and invoice, on hand −36, 24 still reserved, the dealer owes the invoice', async () => {
    const before = await dealerBalance();
    const onHand = (await balance(warehouseA)).qtyOnHand;
    const order =
      await import('../../src/modules/wholesaleOrder/wholesaleOrder.service.js').then((m) =>
        m.getOrder(as.STORE_KEEPER!, oid(orderId)),
      );
    const d = await createDispatch(as.STORE_KEEPER!, {
      orderId,
      lines: [{ orderLineId: order.lines[0]!.id, qtyBase: 36 }],
    });
    await packDispatch(as.STORE_KEEPER!, oid(d.id));
    const posted = await postDispatch(as.STORE_KEEPER!, oid(d.id));
    expect(posted.dispatch.docNo).toMatch(/^CHL-/);
    expect(posted.invoice?.docNo).toMatch(/^WS-/);
    invoiceId = posted.invoice!.id;
    const b = await balance(warehouseA);
    expect(b.qtyOnHand).toBe(onHand - 36);
    expect(b.qtyReserved).toBe(24);
    expect(await dealerBalance()).toBe(before + posted.invoice!.grandTotalMinor);
    expect(posted.invoice!.grandTotalMinor).toBe(3 * DOZEN_PRICE);
  });

  it('7. a rep’s order past the limit waits for a manager; approved with a reason, it is audited', async () => {
    // Exposure now: ৳18,000 invoiced + ৳12,000 still on order. 4 more dozen (৳24,000) → ৳54,000.
    // Warehouse A has only 3 dozen free after step 6 (and 3 dozen stays under the limit), so the
    // store keeper receives 2 more first — the order must fail on credit, not on stock.
    const g = await createGrn(as.STORE_KEEPER!, {
      supplierPartyId: supplierId,
      locationId: String(warehouseA),
      supplierInvoiceNo: 'ACC-2',
      lines: [{ productId: frameId, uomCode: 'DOZ', qty: 2 }],
    });
    await postGrn(as.STORE_KEEPER!, oid(g.id));
    const draft = await createOrder(as.SALES_REP!, {
      dealerPartyId: dealerId,
      locationId: String(warehouseA),
      lines: [{ productId: frameId, uomCode: 'DOZ', qty: 4 }],
    });
    const parked = await confirmOrder(as.SALES_REP!, oid(draft.id), {});
    expect(parked.status).toBe('PENDING_APPROVAL');
    expect(parked.creditCheck?.status).toBe('BLOCKED');
    const approved = await approveOrder(as.SALES_MANAGER!, oid(draft.id), {
      reason: 'Pays on the 5th — spoke to the owner',
    });
    expect(approved.status).toBe('CONFIRMED');
    const audit = await AuditLog.findOne({
      orgId: f.orgId,
      action: 'CREDIT_OVERRIDE',
      entityId: oid(draft.id),
    }).lean();
    expect(audit).toMatchObject({ reason: 'Pays on the 5th — spoke to the owner' });
  });

  it('8. a part-payment: oldest-first proposal, the invoice PARTIAL, the statement and ageing agree', async () => {
    const preview = await allocationPreview(as.ACCOUNTS!, {
      partyId: dealerId,
      amountMinor: 1_000_000,
    });
    expect(preview.allocations).toEqual([
      expect.objectContaining({ invoiceId, amountMinor: 1_000_000 }),
    ]);
    await postReceipt(as.ACCOUNTS!, {
      partyId: dealerId,
      amountMinor: 1_000_000,
      method: 'CASH',
    });
    const inv = (await Invoice.findById(invoiceId).lean())!;
    expect(inv).toMatchObject({
      paymentStatus: 'PARTIAL',
      balanceMinor: 3 * DOZEN_PRICE - 1_000_000,
    });
    const s = await partyStatement(as.ACCOUNTS!, {
      partyId: dealerId,
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(s.lines.map((l) => l.runningMinor)).toEqual([1_800_000, 800_000]);
    expect(s.closingBalanceMinor).toBe(s.currentBalanceMinor);
    const ageing = await ageingReport(as.ACCOUNTS!, { partyId: dealerId });
    expect(ageing.rows[0]!.buckets.CURRENT).toBe(800_000); // 30-day terms: not yet due
  });

  it('9. 1 dozen back damaged, to the damage room: a credit note, and the ledger credit', async () => {
    const inv = (await Invoice.findById(invoiceId).lean())!;
    const line = String((inv.lines[0] as unknown as { _id: Types.ObjectId })._id);
    const before = await dealerBalance();
    const { salesReturn, creditNote } = await postWholesaleReturn(as.SALES_MANAGER!, {
      invoiceId,
      reason: 'DAMAGED',
      settlement: 'CREDIT_NOTE',
      lines: [
        {
          invoiceLineId: line,
          qtyBase: 12,
          condition: 'DAMAGED',
          restockLocationId: String(damageRoom),
        },
      ],
    });
    expect(creditNote).toMatchObject({
      docNo: expect.stringMatching(/^CN-/),
      amountMinor: DOZEN_PRICE,
    });
    expect((await balance(damageRoom)).qtyOnHand).toBe(12);
    expect(salesReturn.lines[0]).toMatchObject({
      condition: 'DAMAGED',
      restockLocationId: String(damageRoom),
    });
    expect(
      await LedgerEntry.findOne({ orgId: f.orgId, refId: oid(creditNote!.id) }).lean(),
    ).toMatchObject({
      docType: 'CREDIT_NOTE',
      creditMinor: DOZEN_PRICE,
    });
    expect(await dealerBalance()).toBe(before - DOZEN_PRICE);
  });

  it('10. reconcile: zero drift on stock and on party balances', async () => {
    expect((await reconcileStock(f.orgId)).clean).toBe(true);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});
