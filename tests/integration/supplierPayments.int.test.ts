import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { GoodsReceipt } from '../../src/modules/goodsReceipt/goodsReceipt.model.js';
import { createGrn, postGrn } from '../../src/modules/goodsReceipt/goodsReceipt.service.js';
import { purchaseRegister } from '../../src/modules/goodsReceipt/purchaseRegister.service.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { partyStatement, reconcileLedger } from '../../src/modules/ledger/ledger.service.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import {
  allocateSupplierPayment,
  listSupplierPayments,
  payablesPreview,
  postSupplierPayment,
} from '../../src/modules/payment/supplierPayment.service.js';
import { listReceipts } from '../../src/modules/payment/receipt.service.js';
import { createPurchaseReturn } from '../../src/modules/purchaseReturn/purchaseReturn.service.js';
import { ALL_PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { GoodsReceiptPayload } from '../../src/shared/types.js';

/**
 * Day 35's "done when", against a real replica set in a throwaway org:
 *   - a supplier payment allocates against the payables goods receipts created;
 *   - the supplier statement balances.
 *
 * Two bills: 12 frames at ৳40 (৳480, billed 1 Sep) and a lensmeter at ৳40,000 (billed 20 Sep).
 * A supplier's balance is negative while we owe them.
 */

let f: PosFixture;
let actor: RequestActor;
let supplierId: string;
let frames: GoodsReceiptPayload;
let machine: GoodsReceiptPayload;

const oid = (id: string) => new Types.ObjectId(id);
const balance = async () => (await Party.findById(supplierId).lean())!.currentBalanceMinor;
const bill = async (g: GoodsReceiptPayload) => {
  const d = (await GoodsReceipt.findById(g.id).lean())!;
  return {
    paid: d.paidMinor,
    credited: d.creditedMinor,
    balance: d.balanceMinor,
    status: d.paymentStatus,
  };
};

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
  supplierId = (
    await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'SUPPLIER',
      { name: 'ZZTEST Pay Supplier', supplier: { paymentTermsDays: 30 } },
    )
  ).id;
  const receive = async (
    lines: Parameters<typeof createGrn>[1]['lines'],
    billNo: string,
    billDate: string,
  ) => {
    const g = await createGrn(actor, {
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      supplierInvoiceNo: billNo,
      supplierInvoiceDate: billDate,
      lines,
    });
    return postGrn(actor, oid(g.id));
  };
  frames = await receive(
    [{ productId: f.frameId, qty: 12, unitCostMinor: 4_000 }],
    'B-1',
    '2026-09-01',
  );
  machine = await receive(
    [{ productId: f.machineId, qty: 1, unitCostMinor: 4_000_000, serials: ['ZZSN-90'] }],
    'B-2',
    '2026-09-20',
  );
}, 180_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('THE DONE-WHEN: a payment settles GRN payables', () => {
  it('the bills are on the ledger: we owe ৳40,480', async () => {
    expect(await balance()).toBe(-4_048_000);
    expect(frames.dueDate?.slice(0, 10)).toBe('2026-10-01');
  });

  it('the preview proposes oldest due first', async () => {
    const p = await payablesPreview(actor, { partyId: supplierId, amountMinor: 1_000_000 });
    expect(p.openPayables.map((o) => [o.docNo, o.balanceMinor])).toEqual([
      [frames.docNo, 48_000],
      [machine.docNo, 4_000_000],
    ]);
    expect(p.allocations.map((a) => [a.docNo, a.amountMinor])).toEqual([
      [frames.docNo, 48_000],
      [machine.docNo, 952_000],
    ]);
    expect(p).toMatchObject({ totalOpenMinor: 4_048_000, unallocatedMinor: 0 });
  });

  it('posting ৳10,000 oldest-first: frames paid, the lensmeter part-paid, the supplier debited', async () => {
    const r = await postSupplierPayment(actor, {
      partyId: supplierId,
      amountMinor: 1_000_000,
      method: 'BANK',
      reference: 'TT-1182',
    });
    expect(r.payment).toMatchObject({
      docNo: expect.stringMatching(/^PAY-/),
      allocatedMinor: 1_000_000,
      unallocatedMinor: 0,
    });
    expect(r.payables.map((p) => [p.docNo, p.balanceMinor, p.paymentStatus])).toEqual([
      [frames.docNo, 0, 'PAID'],
      [machine.docNo, 3_048_000, 'PARTIAL'],
    ]);
    expect(await bill(frames)).toMatchObject({ paid: 48_000, balance: 0, status: 'PAID' });
    expect(await balance()).toBe(-3_048_000);
    const entry = await LedgerEntry.findOne({
      orgId: f.orgId,
      refId: oid(r.payment.id),
    }).lean();
    expect(entry).toMatchObject({ docType: 'PAYMENT', debitMinor: 1_000_000, creditMinor: 0 });
  });

  it('refuses a paid bill, an overpayment, and a dealer — and moves nothing', async () => {
    const before = await balance();
    const e = await refusal(
      postSupplierPayment(actor, {
        partyId: supplierId,
        amountMinor: 100_000,
        method: 'CASH',
        allocations: [
          { grnId: frames.id, amountMinor: 1_000 },
          { grnId: machine.id, amountMinor: 200_000 },
        ],
      }),
    );
    expect(e.details).toEqual([
      { path: 'allocations.0.grnId', message: expect.stringContaining('Not an open') },
      { path: 'allocations', message: expect.stringContaining('only 100000') },
    ]);
    const dealer = await refusal(
      postSupplierPayment(actor, { partyId: f.dealerId, amountMinor: 1, method: 'CASH' }),
    );
    expect(dealer.details).toEqual([{ path: 'partyId', message: 'No such supplier' }]);
    expect(await balance()).toBe(before);
  });

  it('an advance, allocated later', async () => {
    const r = await postSupplierPayment(actor, {
      partyId: supplierId,
      amountMinor: 100_000,
      method: 'CHEQUE',
      reference: 'CHQ 004512',
      allocations: [],
    });
    expect(r.payment).toMatchObject({ allocatedMinor: 0, unallocatedMinor: 100_000 });
    expect(await bill(machine)).toMatchObject({ balance: 3_048_000 });
    expect(
      (await payablesPreview(actor, { partyId: supplierId, amountMinor: 1 }))
        .existingAdvanceMinor,
    ).toBe(100_000);

    const a = await allocateSupplierPayment(actor, oid(r.payment.id), {});
    expect(a.payment).toMatchObject({ allocatedMinor: 100_000, unallocatedMinor: 0 });
    expect(await bill(machine)).toMatchObject({ paid: 1_052_000, balance: 2_948_000 });
    // Allocating moves no money: the ledger saw it when it was paid.
    expect(await balance()).toBe(-3_048_000 + 100_000);
  });

  it('payments stay out of the dealer receipts list, and list by themselves', async () => {
    const receipts = await listReceipts(actor, { page: 1, limit: 50, order: 'desc' });
    expect(receipts.items.some((p) => p.partyId === supplierId)).toBe(false);
    const pays = await listSupplierPayments(actor, {
      page: 1,
      limit: 50,
      order: 'desc',
      partyId: supplierId,
    });
    expect(pays.items).toHaveLength(2);
  });
});

describe('a return against a bill comes off it; what is left over is credit with the supplier', () => {
  it('returning the ৳40,000 lensmeter against a bill with ৳29,480 left on it', async () => {
    const r = await createPurchaseReturn(actor, {
      grnId: machine.id,
      reason: 'WARRANTY',
      lines: [{ grnLineNo: 1, productId: f.machineId, qty: 1, serials: ['ZZSN-90'] }],
    });
    expect(r).toMatchObject({
      totalMinor: 4_000_000,
      appliedMinor: 2_948_000,
      unappliedMinor: 1_052_000,
    });
    expect(await bill(machine)).toMatchObject({
      credited: 2_948_000,
      balance: 0,
      status: 'PAID',
    });
    // We paid ৳10,520 for something that went back: the supplier owes us that.
    expect(await balance()).toBe(1_052_000);
    expect(
      (await payablesPreview(actor, { partyId: supplierId, amountMinor: 1 }))
        .unappliedReturnsMinor,
    ).toBe(1_052_000);
  });
});

describe('THE DONE-WHEN: the supplier statement balances', () => {
  it('brought forward + entries = carried forward = the live balance, and the ledger reconciles', async () => {
    const s = await partyStatement(actor, {
      partyId: supplierId,
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(s.party.roles).toContain('SUPPLIER');
    expect(s.party.paymentTermsDays).toBe(30);
    expect(s.lines.map((l) => l.docType)).toEqual([
      'PURCHASE',
      'PURCHASE',
      'PAYMENT',
      'PAYMENT',
      'DEBIT_NOTE',
    ]);
    expect(s.openingBalanceMinor).toBe(0);
    expect(s.totals).toEqual({ debitMinor: 1_100_000 + 4_000_000, creditMinor: 4_048_000 });
    expect(s.closingBalanceMinor).toBe(
      s.openingBalanceMinor + s.totals.debitMinor - s.totals.creditMinor,
    );
    expect(s.closingBalanceMinor).toBe(s.currentBalanceMinor);
    expect(s.lines.at(-1)!.runningMinor).toBe(1_052_000);
    expect((await reconcileLedger(f.orgId)).clean).toBe(true);
  });

  it('the purchase register ties to the ledger', async () => {
    // `to` left to the server: today in the org's zone, not UTC's (a day behind before 6 a.m.).
    const reg = await purchaseRegister(actor, {
      from: '2026-01-01',
      supplierPartyId: supplierId,
    });
    expect(reg.rows.map((r) => [r.kind, r.totalMinor])).toEqual([
      ['GRN', 48_000],
      ['GRN', 4_000_000],
      ['RETURN', -4_000_000],
    ]);
    const ledger = await LedgerEntry.aggregate<{ _id: string; d: number; c: number }>([
      { $match: { orgId: f.orgId, partyId: oid(supplierId) } },
      { $group: { _id: '$docType', d: { $sum: '$debitMinor' }, c: { $sum: '$creditMinor' } } },
    ]);
    const by = Object.fromEntries(ledger.map((l) => [l._id, l]));
    expect(reg.totals).toMatchObject({
      billedMinor: by.PURCHASE!.c,
      returnedMinor: by.DEBIT_NOTE!.d,
      netMinor: 48_000,
      paidMinor: 1_100_000,
      // Nothing owed on either bill; the unapplied debit note shows as −৳10,520.
      balanceMinor: -1_052_000,
    });
  });
});
