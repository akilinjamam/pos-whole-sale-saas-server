import mongoose, { Types } from 'mongoose';

import { withTransaction } from '../../../src/lib/withTransaction.js';
import { Location } from '../../../src/modules/location/location.model.js';
import { Org } from '../../../src/modules/org/org.model.js';
import { createParty } from '../../../src/modules/party/party.service.js';
import { createProduct } from '../../../src/modules/product/product.service.js';
import { postMovements } from '../../../src/services/stock.service.js';
import { ALL_PERMISSIONS } from '../../../src/shared/permissions.js';

import type { RequestActor } from '../../../src/lib/requestUser.js';
import type { Permission } from '../../../src/shared/permissions.js';

/**
 * A complete, throwaway org for counter tests: a COUNTER location, a frame (PCS, DOZ ×12), a
 * serial-tracked machine, opening stock, and a dealer with a credit limit. Every document it — and
 * the tests — create carries this `orgId`, so `cleanupOrg` removes exactly them and nothing else.
 */

export interface PosFixture {
  orgId: Types.ObjectId;
  locationId: Types.ObjectId;
  userId: Types.ObjectId;
  frameId: string;
  machineId: string;
  dealerId: string;
}

export function actorFor(
  f: Pick<PosFixture, 'orgId' | 'userId'>,
  permissions: readonly Permission[] = ALL_PERMISSIONS,
): RequestActor {
  return {
    orgId: f.orgId,
    actorId: f.userId,
    user: {
      id: String(f.userId),
      orgId: String(f.orgId),
      name: 'ZZTEST Cashier',
      email: 'zztest@example.invalid',
      roleIds: [],
      roleCodes: [],
      permissions: [...permissions],
      locationIds: [],
      defaultLocationId: null,
      mustChangePassword: false,
      emailVerified: true,
    },
  };
}

export async function createPosFixture(): Promise<PosFixture> {
  const orgId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  await Org.create({
    _id: orgId,
    name: 'ZZTEST Org',
    currency: 'BDT',
    timeZone: 'Asia/Dhaka',
    fiscalYearStartMonth: 7,
    settings: {
      enforceCreditLimit: true,
      defaultRetailTierId: null,
      defaultPaymentTermsDays: 30,
    },
  });
  const location = await Location.create({
    orgId,
    code: 'ZZCTR',
    name: 'ZZTEST Counter',
    type: 'COUNTER',
    allowsSales: true,
  });
  const actor = actorFor({ orgId, userId });

  const frame = await createProduct(
    orgId,
    {
      sku: 'ZZ-FRM',
      name: 'ZZTEST Aviator',
      type: 'FRAME',
      baseUom: 'PCS',
      packs: [{ code: 'DOZ', name: 'Dozen', factor: 12, barcode: null }],
      defaultSellPriceMinor: 6_000,
      attrs: { polarized: false, uvProtection: false, hasCase: false },
    },
    userId,
    true,
  );
  const machine = await createProduct(
    orgId,
    {
      sku: 'ZZ-MCH',
      name: 'ZZTEST Lensmeter',
      type: 'MACHINE',
      baseUom: 'PCS',
      trackingMode: 'SERIAL',
      defaultSellPriceMinor: 5_000_000,
      attrs: { installationRequired: false, warrantyMonths: 12 },
    },
    userId,
    true,
  );
  const dealer = await createParty(
    { orgId, actorId: userId, permissions: ALL_PERMISSIONS },
    'DEALER',
    {
      name: 'ZZTEST Rahman Optics',
      dealer: { creditLimitMinor: 20_000_000, paymentTermsDays: 30 },
    },
  );

  await withTransaction((session) =>
    postMovements(session, {
      orgId,
      postedAt: new Date(),
      actorId: userId,
      movements: [
        {
          locationId: location._id,
          productId: new Types.ObjectId(frame.id),
          variantId: null,
          qtyBase: 60,
          movementType: 'OPENING',
          refType: 'ZZTEST',
          unitCostMinor: 3_000,
        },
        {
          locationId: location._id,
          productId: new Types.ObjectId(machine.id),
          variantId: null,
          qtyBase: 2,
          movementType: 'OPENING',
          refType: 'ZZTEST',
          serials: ['ZZSN-1', 'ZZSN-2'],
        },
      ],
    }),
  );

  return {
    orgId,
    locationId: location._id,
    userId,
    frameId: frame.id,
    machineId: machine.id,
    dealerId: dealer.id,
  };
}

/** Delete every document carrying this org id, in every collection — via the driver, since the
 *  append-only ledgers refuse deletes through their models by design. */
export async function cleanupOrg(orgId: Types.ObjectId): Promise<void> {
  const db = mongoose.connection.db!;
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (name === 'orgs' || name === 'counters' || name.startsWith('system.')) continue;
    await db.collection(name).deleteMany({ orgId });
  }
  await db.collection('orgs').deleteOne({ _id: orgId });
  await db
    .collection('counters')
    .deleteMany({ _id: { $regex: `^${String(orgId)}:` } } as never);
}
