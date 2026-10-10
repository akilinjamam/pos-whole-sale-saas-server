import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { invoiceActivity, listInvoices } from '../../src/modules/invoice/invoice.service.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { partyStatement, reconcileLedger } from '../../src/modules/ledger/ledger.service.js';
import { Location } from '../../src/modules/location/location.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { PaymentDoc } from '../../src/modules/payment/paymentDoc.model.js';
import { postReceipt } from '../../src/modules/payment/receipt.service.js';
import { listSupplierPayments } from '../../src/modules/payment/supplierPayment.service.js';
import { CreditNote } from '../../src/modules/salesReturn/creditNote.model.js';
import {
  allocateCreditNote,
  listCreditNotes,
} from '../../src/modules/salesReturn/creditNote.service.js';
import {
  getReturnableWholesaleInvoice,
  listSalesReturns,
  postWholesaleReturn,
} from '../../src/modules/salesReturn/salesReturn.service.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import { WholesaleOrder } from '../../src/modules/wholesaleOrder/wholesaleOrder.model.js';
import {
  confirmOrder,
  createOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { Permission } from '../../src/shared/permissions.js';
import type { WholesaleReturnInput } from '../../src/shared/returns.js';

/**
 * Day 36's "done when", against a real replica set in a throwaway org:
 *   a wholesale return restocks to the chosen location, raises a credit note, and the credit
 *   allocates against an open invoice.
 *
 * Two invoices to the dealer, raised by posted challans: WS1 12 frames ৳720, WS2 6 frames ৳360.
 * Frames are ৳60 each. A warehouse and a damage room besides the counter they shipped from.
 */

let f: PosFixture;
let actor: RequestActor;
let clerk: RequestActor;
let ws1: { id: string; docNo: string; orderId: string };
let ws2: { id: string; docNo: string; orderId: string };
let warehouseId: string;
let damageId: string;

const oid = (id: string) => new Types.ObjectId(id);
const balance = async () => (await Party.findById(f.dealerId).lean())!.currentBalanceMinor;
const invoice = async (id: string) => (await Invoice.findById(id).lean())!;
const onHand = async (locationId: string | Types.ObjectId) =>
  (
    await StockBalance.findOne({
      orgId: f.orgId,
      locationId: new Types.ObjectId(String(locationId)),
      productId: oid(f.frameId),
    }).lean()
  )?.qtyOnHand ?? 0;

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

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
  return { id: r.invoice!.id, docNo: r.invoice!.docNo!, orderId: order.id };
}

const lineOf = async (id: string) =>
  String(((await invoice(id)).lines[0] as unknown as { _id: Types.ObjectId })._id);

beforeAll(async () => {
  await connectDatabase();
  await CreditNote.syncIndexes();
  f = await createPosFixture();
  actor = actorFor(f);
  const RETURNS: Permission[] = ['return:read', 'return:create', 'creditNote:read'];
  clerk = actorFor(f, RETURNS);
  warehouseId = String(
    (
      await Location.create({
        orgId: f.orgId,
        code: 'ZZWH',
        name: 'ZZTEST Warehouse',
        type: 'WAREHOUSE',
      })
    )._id,
  );
  damageId = String(
    (
      await Location.create({
        orgId: f.orgId,
        code: 'ZZDMG',
        name: 'ZZTEST Damage',
        type: 'DAMAGE',
      })
    )._id,
  );
  ws1 = await invoiced(12);
  ws2 = await invoiced(6);
}, 180_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('THE DONE-WHEN', () => {
  it('the return screen: what can come back, and where', async () => {
    const r = await getReturnableWholesaleInvoice(actor, oid(ws1.id));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      returnableBase: 12,
      trackingMode: 'NONE',
      unitValueMinor: 6_000,
    });
    expect(r.defaultLocationId).toBe(String(f.locationId));
    expect(r.damageLocationIds).toEqual([damageId]);
  });

  it('restocks good to the warehouse and damaged to the damage room, and raises a credit note on WS1', async () => {
    const line = await lineOf(ws1.id);
    const before = {
      balance: await balance(),
      wh: await onHand(warehouseId),
      dmg: await onHand(damageId),
    };

    const { salesReturn: r, creditNote: cn } = await postWholesaleReturn(clerk, {
      invoiceId: ws1.id,
      reason: 'DAMAGED',
      settlement: 'CREDIT_NOTE',
      lines: [
        { invoiceLineId: line, qtyBase: 2, condition: 'GOOD', restockLocationId: warehouseId },
        { invoiceLineId: line, qtyBase: 1, condition: 'DAMAGED', restockLocationId: damageId },
      ],
    });
    expect(r).toMatchObject({
      docNo: expect.stringMatching(/^SR-/),
      channel: 'WHOLESALE',
      grandTotalMinor: 18_000,
      creditNoteDocNo: expect.stringMatching(/^CN-/),
    });
    expect(r.lines.map((l) => [l.condition, l.restockLocationId])).toEqual([
      ['GOOD', warehouseId],
      ['DAMAGED', damageId],
    ]);

    // Stock: exactly where the person sent it.
    expect(await onHand(warehouseId)).toBe(before.wh + 2);
    expect(await onHand(damageId)).toBe(before.dmg + 1);
    const moves = await StockLedger.find({ orgId: f.orgId, refId: oid(r.id) }).lean();
    expect(moves.every((m) => m.movementType === 'SALE_RETURN' && m.qtyBase > 0)).toBe(true);

    // The credit note: a ledger CREDIT, allocated to the invoice the goods came back from.
    expect(cn).toMatchObject({
      amountMinor: 18_000,
      allocatedMinor: 18_000,
      unallocatedMinor: 0,
    });
    expect(cn!.allocations).toEqual([
      expect.objectContaining({ invoiceId: ws1.id, docNo: ws1.docNo, amountMinor: 18_000 }),
    ]);
    expect(
      await LedgerEntry.findOne({ orgId: f.orgId, refId: oid(cn!.id) }).lean(),
    ).toMatchObject({
      docType: 'CREDIT_NOTE',
      creditMinor: 18_000,
    });
    expect(await balance()).toBe(before.balance - 18_000);
    expect(await invoice(ws1.id)).toMatchObject({
      creditedMinor: 18_000,
      balanceMinor: 72_000 - 18_000,
      paymentStatus: 'PARTIAL',
    });
    expect((await invoice(ws1.id)).lines[0]!.qtyReturnedBase).toBe(3);
    const order = await WholesaleOrder.findById(ws1.orderId).lean();
    expect(order!.lines[0]!.qtyReturnedBase).toBe(3);
  });

  it('an open credit note allocates against another open invoice later', async () => {
    // WS2 is the one they want it set against: raise it open, then allocate.
    const line = await lineOf(ws1.id);
    const { creditNote: cn } = await postWholesaleReturn(actor, {
      invoiceId: ws1.id,
      reason: 'NOT_SOLD',
      settlement: 'CREDIT_NOTE',
      allocations: [],
      lines: [
        {
          invoiceLineId: line,
          qtyBase: 4,
          condition: 'GOOD',
          restockLocationId: String(f.locationId),
        },
      ],
    });
    expect(cn).toMatchObject({
      amountMinor: 24_000,
      allocatedMinor: 0,
      unallocatedMinor: 24_000,
    });
    expect(
      (
        await listCreditNotes(actor, { page: 1, limit: 10, order: 'desc', unallocated: true })
      ).items.map((c) => c.id),
    ).toEqual([cn!.id]);

    const ledgerRows = await LedgerEntry.countDocuments({ orgId: f.orgId });
    const before = await balance();
    const spent = await allocateCreditNote(actor, oid(cn!.id), {
      allocations: [{ invoiceId: ws2.id, amountMinor: 24_000 }],
    });
    expect(spent).toMatchObject({ allocatedMinor: 24_000, unallocatedMinor: 0 });
    expect(await invoice(ws2.id)).toMatchObject({
      creditedMinor: 24_000,
      balanceMinor: 36_000 - 24_000,
      paymentStatus: 'PARTIAL',
    });
    // Allocation moves no money: the credit was on the ledger when it was raised.
    expect(await balance()).toBe(before);
    expect(await LedgerEntry.countDocuments({ orgId: f.orgId })).toBe(ledgerRows);
  });

  it('the statement still balances, and the ledger reconciles', async () => {
    const s = await partyStatement(actor, {
      partyId: f.dealerId,
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(s.closingBalanceMinor).toBe(
      s.openingBalanceMinor + s.totals.debitMinor - s.totals.creditMinor,
    );
    expect(s.closingBalanceMinor).toBe(s.currentBalanceMinor);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});

describe('refusals leave nothing behind', () => {
  const footprint = async () => ({
    balance: await balance(),
    stock: await StockLedger.countDocuments({ orgId: f.orgId }),
    returns: (await listSalesReturns(actor, { page: 1, limit: 50, order: 'desc' })).meta.total,
    notes: await CreditNote.countDocuments({ orgId: f.orgId }),
    ws1: (await invoice(ws1.id)).lines[0]!.qtyReturnedBase,
  });

  it('more than is left, damaged to the shelf, good to the damage room, a credit too big', async () => {
    const line = await lineOf(ws1.id);
    const before = await footprint();
    const base = (over: Partial<WholesaleReturnInput>): WholesaleReturnInput => ({
      invoiceId: ws1.id,
      reason: 'OTHER',
      settlement: 'CREDIT_NOTE',
      lines: [
        { invoiceLineId: line, qtyBase: 1, condition: 'GOOD', restockLocationId: warehouseId },
      ],
      ...over,
    });
    // 7 of 12 have come back: 5 left, asked as 3 + 3 on two rows.
    const tooMany = await refusal(
      postWholesaleReturn(
        actor,
        base({
          lines: [
            {
              invoiceLineId: line,
              qtyBase: 3,
              condition: 'GOOD',
              restockLocationId: warehouseId,
            },
            {
              invoiceLineId: line,
              qtyBase: 3,
              condition: 'DAMAGED',
              restockLocationId: damageId,
            },
          ],
        }),
      ),
    );
    expect(tooMany.details).toEqual([
      { path: 'lines.1.qtyBase', message: expect.stringContaining('Only 2') },
    ]);
    const wrongPlace = await refusal(
      postWholesaleReturn(
        actor,
        base({
          lines: [
            {
              invoiceLineId: line,
              qtyBase: 1,
              condition: 'DAMAGED',
              restockLocationId: warehouseId,
            },
            { invoiceLineId: line, qtyBase: 1, condition: 'GOOD', restockLocationId: damageId },
          ],
        }),
      ),
    );
    expect(wrongPlace.details).toEqual([
      { path: 'lines.0.restockLocationId', message: 'Damaged goods go to a damage location' },
      { path: 'lines.1.restockLocationId', message: expect.stringContaining('damaged goods') },
    ]);
    const overAllocated = await refusal(
      postWholesaleReturn(
        actor,
        base({ allocations: [{ invoiceId: ws2.id, amountMinor: 99_000 }] }),
      ),
    );
    expect((overAllocated.details as { path: string }[])[0]).toMatchObject({
      path: 'allocations.0.amountMinor',
    });
    expect(await footprint()).toEqual(before);
  });

  it('a refund needs return:approve, and only for money actually paid', async () => {
    const line = await lineOf(ws2.id);
    const input: WholesaleReturnInput = {
      invoiceId: ws2.id,
      reason: 'WRONG_ITEM',
      settlement: 'CASH_REFUND',
      lines: [
        { invoiceLineId: line, qtyBase: 1, condition: 'GOOD', restockLocationId: warehouseId },
      ],
    };
    expect((await refusal(postWholesaleReturn(clerk, input))).status).toBe(403);
    const unpaid = await refusal(postWholesaleReturn(actor, input));
    expect(unpaid.details).toEqual([
      { path: 'settlement', message: expect.stringContaining('Only 0 was paid') },
    ]);
  });
});

describe('a cash refund on a paid invoice', () => {
  it('credits the goods and pays the money out: the balance stands, and it is not a supplier payment', async () => {
    await postReceipt(actor, {
      partyId: f.dealerId,
      amountMinor: 12_000,
      method: 'CASH',
      allocations: [{ invoiceId: ws2.id, amountMinor: 12_000 }],
    });
    const before = { balance: await balance(), inv: await invoice(ws2.id) };
    const line = await lineOf(ws2.id);
    const { salesReturn: r, creditNote } = await postWholesaleReturn(actor, {
      invoiceId: ws2.id,
      reason: 'WRONG_ITEM',
      settlement: 'CASH_REFUND',
      refundMethod: 'BANK',
      reference: 'TT-REF-1',
      lines: [
        { invoiceLineId: line, qtyBase: 1, condition: 'GOOD', restockLocationId: warehouseId },
      ],
    });
    expect(creditNote).toBeNull();
    expect(r).toMatchObject({
      settlement: 'CASH_REFUND',
      refundDocNo: expect.stringMatching(/^PAY-/),
    });
    expect(await balance()).toBe(before.balance);
    expect(await invoice(ws2.id)).toMatchObject({
      paidMinor: before.inv.paidMinor - 6_000,
      creditedMinor: before.inv.creditedMinor + 6_000,
      balanceMinor: before.inv.balanceMinor,
    });
    const refund = await PaymentDoc.findOne({ orgId: f.orgId, docNo: r.refundDocNo }).lean();
    expect(refund).toMatchObject({
      direction: 'OUT',
      isRefund: true,
      method: 'BANK',
      amountMinor: 6_000,
    });
    expect(
      (await listSupplierPayments(actor, { page: 1, limit: 50, order: 'desc' })).items,
    ).toHaveLength(0);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });
});

describe('the invoice screen (Day 36b)', () => {
  it('shows what settled each invoice and what came back', async () => {
    const a1 = await invoiceActivity(actor, oid(ws1.id));
    expect(a1.returns.map((r) => [r.qtyBase, r.settlement])).toEqual([
      [3, 'CREDIT_NOTE'],
      [4, 'CREDIT_NOTE'],
    ]);
    expect(a1.creditNotes.map((c) => c.amountMinor)).toEqual([18_000]);
    expect(a1.payments).toEqual([]);

    const a2 = await invoiceActivity(actor, oid(ws2.id));
    expect(a2.creditNotes.map((c) => c.amountMinor)).toEqual([24_000]);
    expect(a2.payments.map((p) => p.amountMinor)).toEqual([12_000]);
    expect(a2.returns.map((r) => r.settlement)).toEqual(['CASH_REFUND']);
  });

  it('lists by payment status, open balance, date and customer name', async () => {
    const page = (q: Record<string, unknown>) =>
      listInvoices(actor, { page: 1, limit: 50, order: 'desc', channel: 'WHOLESALE', ...q });
    const ids = (r: Awaited<ReturnType<typeof page>>) => r.items.map((i) => i.id).sort();
    // WS2 is settled by now: ৳240 credit + ৳120 receipt = its ৳360.
    expect(ids(await page({ open: true }))).toEqual([ws1.id]);
    expect(ids(await page({ paymentStatus: 'PARTIAL' }))).toEqual([ws1.id]);
    expect(ids(await page({ paymentStatus: 'PAID' }))).toEqual([ws2.id]);
    expect((await page({ from: '2001-01-01', to: '2001-12-31' })).items).toEqual([]);
    expect((await page({ q: 'zztest' })).meta.total).toBe(2);
  });
});
