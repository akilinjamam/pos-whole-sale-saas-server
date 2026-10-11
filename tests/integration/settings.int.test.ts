import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { withTransaction } from '../../src/lib/withTransaction.js';
import { AuditLog } from '../../src/modules/audit/auditLog.model.js';
import {
  createDispatch,
  packDispatch,
  postDispatch,
} from '../../src/modules/dispatch/dispatch.service.js';
import { Invoice } from '../../src/modules/invoice/invoice.model.js';
import { notifications } from '../../src/modules/notifications/notifications.service.js';
import { updateSeries } from '../../src/modules/numberSeries/numberSeries.service.js';
import { updateOrg, updateOrgSettings } from '../../src/modules/org/org.service.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createPriceEntry } from '../../src/modules/priceList/priceList.service.js';
import { createPriceTier } from '../../src/modules/priceTier/priceTier.service.js';
import { resolveForRequest } from '../../src/modules/pricing/pricing.service.js';
import { Product } from '../../src/modules/product/product.model.js';
import { postMovements } from '../../src/services/stock.service.js';
import {
  confirmOrder,
  createOrder,
} from '../../src/modules/wholesaleOrder/wholesaleOrder.service.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';

/**
 * Day 39's "done when", against a real replica set in a throwaway org:
 *   every `org.settings` flag is editable — through the same service the settings screen calls —
 *   and actually changes behaviour. Each change is audited.
 */

let f: PosFixture;
let actor: RequestActor;
/** Takes orders, decides nothing: an over-limit confirm by a rep waits for a manager. */
let rep: RequestActor;
const oid = (id: string) => new Types.ObjectId(id);

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/** A confirmed order for `qty` frames, dispatched in one challan. */
async function ship(qty: number) {
  const draft = await createOrder(actor, {
    dealerPartyId: f.dealerId,
    locationId: String(f.locationId),
    lines: [{ productId: f.frameId, qty }],
  });
  const order = await confirmOrder(actor, oid(draft.id), {});
  const d = await createDispatch(actor, { orderId: order.id });
  await packDispatch(actor, oid(d.id));
  return postDispatch(actor, oid(d.id));
}

beforeAll(async () => {
  await connectDatabase();
  f = await createPosFixture();
  actor = actorFor(f);
  rep = actorFor(f, [
    'order:read',
    'order:create',
    'order:update',
    'order:confirm',
    'product:read',
    'price:read',
    'dealer:read',
  ]);
  await Party.updateOne(
    { _id: f.dealerId },
    {
      $set: { 'dealer.creditLimitMinor': 100_000_000 },
      $unset: { 'dealer.paymentTermsDays': 1 },
    },
  );
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('THE DONE-WHEN: every setting is editable and changes behaviour', () => {
  it('invoiceOnDispatch: off, a challan raises no invoice; on, it does', async () => {
    await updateOrgSettings(actor, { invoiceOnDispatch: false });
    const off = await ship(2);
    expect(off.invoice).toBeNull();
    await updateOrgSettings(actor, { invoiceOnDispatch: true });
    const on = await ship(2);
    expect(on.invoice?.docNo).toMatch(/^WS-/);
  });

  it('allowNegativeStock: off, an oversell is refused; on, it goes through', async () => {
    const out = (qtyBase: number) =>
      withTransaction((session) =>
        postMovements(session, {
          orgId: f.orgId,
          postedAt: new Date(),
          actorId: f.userId,
          movements: [
            {
              locationId: f.locationId,
              productId: oid(f.frameId),
              variantId: null,
              qtyBase,
              movementType: 'ADJUSTMENT',
              refType: 'TEST',
            },
          ],
        }),
      );
    await updateOrgSettings(actor, { allowNegativeStock: false });
    expect((await refusal(out(-10_000))).code).toBe('INSUFFICIENT_STOCK');
    await updateOrgSettings(actor, { allowNegativeStock: true });
    await out(-10_000);
    await out(10_000); // put it back
    await updateOrgSettings(actor, { allowNegativeStock: false });
  });

  it('enforceCreditLimit: on, an order over the limit waits for approval; off, it confirms', async () => {
    await Party.updateOne({ _id: f.dealerId }, { $set: { 'dealer.creditLimitMinor': 1_000 } });
    const confirm = async () => {
      const draft = await createOrder(rep, {
        dealerPartyId: f.dealerId,
        locationId: String(f.locationId),
        lines: [{ productId: f.frameId, qty: 1 }],
      });
      return confirmOrder(rep, oid(draft.id), {});
    };
    await updateOrgSettings(actor, { enforceCreditLimit: true });
    expect((await confirm()).status).toBe('PENDING_APPROVAL');
    await updateOrgSettings(actor, { enforceCreditLimit: false });
    expect((await confirm()).status).toBe('CONFIRMED');
    await updateOrgSettings(actor, { enforceCreditLimit: true });
    await Party.updateOne(
      { _id: f.dealerId },
      { $set: { 'dealer.creditLimitMinor': 100_000_000 } },
    );
  });

  it('defaultRetailTierId: the counter sells at the chosen tier’s price', async () => {
    const tier = await createPriceTier(f.orgId, { code: 'RETAIL', name: 'Retail' }, f.userId);
    await createPriceEntry(
      f.orgId,
      { tierId: tier.id, productId: f.frameId, uomCode: 'PCS', priceMinor: 9_900 },
      f.userId,
    );
    const counterPrice = async () =>
      (await resolveForRequest(f.orgId, { productId: f.frameId, qty: 1 } as never))
        .unitPriceMinor;
    await updateOrgSettings(actor, { defaultRetailTierId: null });
    expect(await counterPrice()).toBe(6_000); // the product's own default
    await updateOrgSettings(actor, { defaultRetailTierId: tier.id });
    expect(await counterPrice()).toBe(9_900);
  });

  it('roundInvoiceTo: an invoice total is rounded, and the difference recorded', async () => {
    // Frames at ৳60.37: 3 of them is ৳181.11.
    await Product.updateOne({ _id: f.frameId }, { $set: { defaultSellPriceMinor: 6_037 } });
    await updateOrgSettings(actor, { roundInvoiceTo: 0, defaultRetailTierId: null });
    const exact = (await ship(3)).invoice!;
    expect(exact).toMatchObject({ grandTotalMinor: 18_111 });
    await updateOrgSettings(actor, { roundInvoiceTo: 100 });
    const rounded = (await ship(3)).invoice!;
    const doc = (await Invoice.findById(rounded.id).lean())!;
    expect(doc).toMatchObject({ grandTotalMinor: 18_100, roundingMinor: -11 });
    expect(doc.lines.reduce((t, l) => t + l.lineTotalMinor, 0) + doc.roundingMinor).toBe(
      18_100,
    );
    await updateOrgSettings(actor, { roundInvoiceTo: 0 });
    await Product.updateOne({ _id: f.frameId }, { $set: { defaultSellPriceMinor: 6_000 } });
  });

  it('defaultPaymentTermsDays: a dealer without terms of their own gets the org’s', async () => {
    const terms = async () =>
      (
        await createOrder(actor, {
          dealerPartyId: f.dealerId,
          locationId: String(f.locationId),
          lines: [{ productId: f.frameId, qty: 1 }],
        })
      ).paymentTermsDays;
    await updateOrgSettings(actor, { defaultPaymentTermsDays: 15 });
    expect(await terms()).toBe(15);
    await updateOrgSettings(actor, { defaultPaymentTermsDays: 45 });
    expect(await terms()).toBe(45);
  });

  it('every change is in the audit log, with only what changed', async () => {
    const rows = await AuditLog.find({ orgId: f.orgId, action: 'SETTINGS_CHANGE' })
      .sort({ at: 1 })
      .lean();
    const changed = rows.flatMap((r) => Object.keys(r.after ?? {}));
    for (const key of [
      'invoiceOnDispatch',
      'allowNegativeStock',
      'enforceCreditLimit',
      'defaultRetailTierId',
      'roundInvoiceTo',
      'defaultPaymentTermsDays',
    ]) {
      expect(changed).toContain(key);
    }
    const last = rows.at(-1)!;
    expect(last).toMatchObject({
      before: { defaultPaymentTermsDays: 15 },
      after: { defaultPaymentTermsDays: 45 },
      actorUserId: actor.actorId,
    });
    // Setting a flag to what it already is is not a change.
    const n = rows.length;
    await updateOrgSettings(actor, { defaultPaymentTermsDays: 45 });
    expect(await AuditLog.countDocuments({ orgId: f.orgId, action: 'SETTINGS_CHANGE' })).toBe(
      n,
    );
  });
});

describe('profile, numbering and notifications', () => {
  it('the invoice header and footer are part of the profile, and audited', async () => {
    const org = await updateOrg(actor, {
      invoiceHeaderNote: 'Authorised distributor',
      invoiceFooter: 'Goods once sold are not taken back without the invoice.',
    });
    expect(org).toMatchObject({ invoiceHeaderNote: 'Authorised distributor' });
    expect(
      await AuditLog.findOne({ orgId: f.orgId, action: 'ORG_PROFILE_CHANGE' }).lean(),
    ).toMatchObject({ after: { invoiceHeaderNote: 'Authorised distributor' } });
  });

  it('a number series change is audited', async () => {
    const s = await updateSeries(actor, 'WS', { padding: 6 });
    expect(s.nextNumber).toMatch(/\d{6}$/);
    expect(
      await AuditLog.findOne({ orgId: f.orgId, action: 'NUMBER_SERIES_CHANGE' }).lean(),
    ).toMatchObject({ docNo: 'WS', after: { padding: 6 } });
  });

  it('notifications: low stock and a pending approval show; each links to its screen', async () => {
    await Product.updateOne({ _id: f.frameId }, { $set: { reorderPoint: 10_000 } });
    await Party.updateOne({ _id: f.dealerId }, { $set: { 'dealer.creditLimitMinor': 1_000 } });
    const draft = await createOrder(rep, {
      dealerPartyId: f.dealerId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, qty: 1 }],
    });
    await confirmOrder(rep, oid(draft.id), {});
    const n = await notifications(actor);
    const kinds = n.items.map((i) => i.kind);
    expect(kinds).toContain('LOW_STOCK');
    expect(kinds).toContain('APPROVAL');
    expect(n.items.find((i) => i.kind === 'LOW_STOCK')!.to).toBe('/purchase/reorder');
    expect(n.total).toBe(n.items.reduce((t, i) => t + i.count, 0));
    // Someone who may see none of it sees nothing.
    const nobody = await notifications(actorFor(f, ['product:read']));
    expect(nobody.items).toEqual([]);
  });
});
