import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { assertLocationAllowed, locationScopeOf } from '../../middleware/requireLocation.js';
import { carryAverageCost, itemAverageCost } from '../../services/itemCost.js';
import { postMovements } from '../../services/stock.service.js';
import {
  assertStockLocation,
  lineNames,
  resolveStockLines,
  trackingFor,
} from '../../services/stockLines.js';
import { Location } from '../location/location.model.js';

import { StockTransfer, toStockTransferPayload } from './stockTransfer.model.js';

import type { ListTransfersQuery } from './stockTransfer.schema.js';
import type { StockTransferDoc } from './stockTransfer.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { MovementInput } from '../../services/stock.service.js';
import type { CreateTransferInput, UpdateTransferInput } from '@shared/stockDocs.js';
import type { PageMeta, StockTransferPayload } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

const REF_TYPE = 'STOCK_TRANSFER';

async function serialize(
  orgId: Types.ObjectId,
  docs: StockTransferDoc[],
): Promise<StockTransferPayload[]> {
  const locationIds = [
    ...new Set(
      docs.flatMap((d) =>
        [d.fromLocationId, d.toLocationId, d.transitLocationId].filter(Boolean).map(String),
      ),
    ),
  ];
  const [names, locations] = await Promise.all([
    lineNames(
      orgId,
      docs.flatMap((d) => d.lines),
    ),
    Location.find({ orgId, _id: { $in: locationIds } })
      .select('name')
      .lean(),
  ]);
  const nameBy = new Map(locations.map((l) => [String(l._id), l.name]));
  return docs.map((d) =>
    toStockTransferPayload(d, {
      lines: names,
      location: (id) => (id ? (nameBy.get(String(id)) ?? null) : null),
    }),
  );
}

async function load(actor: RequestActor, id: Types.ObjectId): Promise<StockTransferDoc> {
  const doc = await StockTransfer.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!doc) throw ApiError.notFound('Transfer');
  return doc;
}

/** A user may see a transfer if they may see either end of it. */
function assertCanSee(actor: RequestActor, doc: StockTransferDoc): void {
  const scope = locationScopeOf(actor.user);
  if (
    scope &&
    !scope.includes(String(doc.fromLocationId)) &&
    !scope.includes(String(doc.toLocationId))
  ) {
    throw ApiError.notFound('Transfer');
  }
}

/**
 * The three locations must exist, the ends must be ordinary stock locations, and the transit leg
 * — if any — must be a `TRANSIT` location. The schema has already checked they are distinct.
 */
async function assertLocations(
  orgId: Types.ObjectId,
  v: { fromLocationId: string; toLocationId: string; transitLocationId?: string | null },
): Promise<void> {
  await Promise.all([
    assertStockLocation(orgId, v.fromLocationId, 'fromLocationId'),
    assertStockLocation(orgId, v.toLocationId, 'toLocationId'),
  ]);
  if (v.transitLocationId) {
    const transit = await assertStockLocation(orgId, v.transitLocationId, 'transitLocationId', {
      allowTransit: true,
    });
    if (transit.type !== 'TRANSIT') {
      throw ApiError.validation('Validation failed', [
        { path: 'transitLocationId', message: `${transit.code} is not a transit location` },
      ]);
    }
  }
}

export async function listTransfers(
  actor: RequestActor,
  query: ListTransfersQuery,
): Promise<{ items: StockTransferPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<StockTransferDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  const within = query.locationId
    ? [new Types.ObjectId(query.locationId)]
    : scope?.map((id) => new Types.ObjectId(id));
  if (within)
    filter.$or = [{ fromLocationId: { $in: within } }, { toLocationId: { $in: within } }];
  if (query.status) filter.status = query.status;

  const { items, meta } = await paginate<StockTransferDoc>(StockTransfer, {
    filter,
    query,
    sortable: ['createdAt', 'postedAt', 'receivedAt', 'docNo'],
    searchFields: ['docNo', 'note'],
    defaultSort: { createdAt: -1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}

export async function getTransfer(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<StockTransferPayload> {
  const doc = await load(actor, id);
  assertCanSee(actor, doc);
  const [payload] = await serialize(actor.orgId, [doc]);
  return payload!;
}

/**
 * Only the **source** must be one of the caller's locations: a storekeeper sends stock to a
 * counter they do not run as a matter of routine. (Which is why the routes do not use
 * `requireLocation` — it would demand both ends.)
 */
export async function createTransfer(
  actor: RequestActor,
  input: CreateTransferInput,
): Promise<StockTransferPayload> {
  assertLocationAllowed(actor.user, input.fromLocationId);
  await assertLocations(actor.orgId, input);
  const lines = await resolveStockLines(actor.orgId, input.lines);

  const doc = await StockTransfer.create({
    orgId: actor.orgId,
    fromLocationId: new Types.ObjectId(input.fromLocationId),
    toLocationId: new Types.ObjectId(input.toLocationId),
    transitLocationId: input.transitLocationId
      ? new Types.ObjectId(input.transitLocationId)
      : null,
    note: input.note ?? null,
    lines,
    createdBy: actor.actorId,
    updatedBy: actor.actorId,
  });
  return getTransfer(actor, doc._id);
}

function assertDraft(doc: StockTransferDoc): void {
  if (doc.status !== 'DRAFT') {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      `${doc.docNo ?? 'This transfer'} has been dispatched — only a draft can be changed`,
    );
  }
}

export async function updateTransfer(
  actor: RequestActor,
  id: Types.ObjectId,
  input: UpdateTransferInput,
): Promise<StockTransferPayload> {
  const doc = await load(actor, id);
  assertLocationAllowed(actor.user, String(doc.fromLocationId));
  assertDraft(doc);

  if (input.fromLocationId) assertLocationAllowed(actor.user, input.fromLocationId);
  const merged = {
    fromLocationId: input.fromLocationId ?? String(doc.fromLocationId),
    toLocationId: input.toLocationId ?? String(doc.toLocationId),
    transitLocationId:
      input.transitLocationId !== undefined
        ? input.transitLocationId
        : doc.transitLocationId
          ? String(doc.transitLocationId)
          : null,
  };
  // An edit to one end must still leave three distinct locations — the schema only saw the patch.
  if (merged.fromLocationId === merged.toLocationId) {
    throw ApiError.validation('Validation failed', [
      { path: 'toLocationId', message: 'Choose a different destination' },
    ]);
  }
  await assertLocations(actor.orgId, merged);
  const lines = input.lines ? await resolveStockLines(actor.orgId, input.lines) : undefined;

  const { matchedCount } = await StockTransfer.updateOne(
    { _id: id, orgId: actor.orgId, status: 'DRAFT' },
    {
      $set: {
        fromLocationId: new Types.ObjectId(merged.fromLocationId),
        toLocationId: new Types.ObjectId(merged.toLocationId),
        transitLocationId: merged.transitLocationId
          ? new Types.ObjectId(merged.transitLocationId)
          : null,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(lines ? { lines } : {}),
        updatedBy: actor.actorId,
      },
    },
  );
  if (matchedCount === 0)
    throw ApiError.conflict('ILLEGAL_TRANSITION', 'Only a draft can be changed');
  return getTransfer(actor, id);
}

export async function deleteTransfer(actor: RequestActor, id: Types.ObjectId): Promise<void> {
  const doc = await load(actor, id);
  assertLocationAllowed(actor.user, String(doc.fromLocationId));
  assertDraft(doc);
  await StockTransfer.deleteOne({ _id: id, orgId: actor.orgId, status: 'DRAFT' });
}

/**
 * One leg: every line out of `from` and into `to`, as an OUT then an IN per line. The same lot
 * and the same serials travel on both halves — a transfer never creates a lot, it moves one.
 *
 * Both halves carry the item's moving average, so the ledger values the move. The average itself
 * does not change — a transfer never changes what a frame cost.
 */
async function leg(
  session: ClientSession,
  actor: RequestActor,
  doc: StockTransferDoc,
  from: Types.ObjectId,
  to: Types.ObjectId,
  docNo: string,
  narration: string,
): Promise<MovementInput[]> {
  const perLine = await Promise.all(
    doc.lines.map(async (l) => {
      const tracking = await trackingFor(session, actor.orgId, l, 'OUT', actor.actorId);
      const cost = await itemAverageCost(session, l.productId, l.variantId);
      const common = {
        productId: l.productId,
        variantId: l.variantId,
        refType: REF_TYPE,
        refId: doc._id,
        refDocNo: docNo,
        narration,
        unitCostMinor: cost || null,
        ...tracking,
      };
      return [
        {
          ...common,
          locationId: from,
          qtyBase: -l.qtyBase,
          movementType: 'TRANSFER_OUT' as const,
        },
        { ...common, locationId: to, qtyBase: l.qtyBase, movementType: 'TRANSFER_IN' as const },
      ];
    }),
  );
  return perLine.flat();
}

/**
 * Dispatch — needs access to the **source**, since that is where the goods leave from.
 *
 * Direct: both legs in this one transaction, so the source and the destination move together or
 * not at all — there is no instant at which the stock is on neither shelf, or on both. Via
 * transit: source → transit now; `receive` does transit → destination.
 */
export async function postTransfer(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<StockTransferPayload> {
  const doc = await load(actor, id);
  assertLocationAllowed(actor.user, String(doc.fromLocationId));
  assertDraft(doc);

  await withTransaction(async (session: ClientSession) => {
    const postedAt = new Date();
    const docNo = await nextDocNo(session, actor.orgId, 'TRF', postedAt);
    const direct = !doc.transitLocationId;

    const claimed = await StockTransfer.findOneAndUpdate(
      { _id: id, orgId: actor.orgId, status: 'DRAFT' },
      {
        $set: {
          status: direct ? 'RECEIVED' : 'IN_TRANSIT',
          docNo,
          postedAt,
          postedBy: actor.actorId,
          ...(direct ? { receivedAt: postedAt, receivedBy: actor.actorId } : {}),
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!claimed) throw ApiError.conflict('ILLEGAL_TRANSITION', 'Already dispatched');

    await postMovements(session, {
      orgId: actor.orgId,
      postedAt,
      actorId: actor.actorId,
      movements: await leg(
        session,
        actor,
        claimed,
        claimed.fromLocationId,
        claimed.transitLocationId ?? claimed.toLocationId,
        docNo,
        direct ? 'Transfer' : 'Transfer — dispatched to transit',
      ),
    });
    // The receiving shelf may be new, and a new balance row starts at cost 0.
    await carryAverageCost(session, actor.orgId, claimed.lines);
  });

  return getTransfer(actor, id);
}

/**
 * Receive a transfer that went via transit — needs access to the **destination**: the person
 * signing for the goods is at the receiving end, and may have no access to the source at all.
 */
export async function receiveTransfer(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<StockTransferPayload> {
  const doc = await load(actor, id);
  assertLocationAllowed(actor.user, String(doc.toLocationId));
  if (doc.status !== 'IN_TRANSIT') {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      doc.status === 'DRAFT'
        ? 'Dispatch it first'
        : `${doc.docNo} is already ${doc.status.toLowerCase()}`,
    );
  }

  await withTransaction(async (session: ClientSession) => {
    const receivedAt = new Date();
    const claimed = await StockTransfer.findOneAndUpdate(
      { _id: id, orgId: actor.orgId, status: 'IN_TRANSIT' },
      {
        $set: {
          status: 'RECEIVED',
          receivedAt,
          receivedBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!claimed) throw ApiError.conflict('ILLEGAL_TRANSITION', 'Already received');

    await postMovements(session, {
      orgId: actor.orgId,
      postedAt: receivedAt,
      actorId: actor.actorId,
      movements: await leg(
        session,
        actor,
        claimed,
        claimed.transitLocationId!,
        claimed.toLocationId,
        claimed.docNo!,
        'Transfer — received from transit',
      ),
    });
    await carryAverageCost(session, actor.orgId, claimed.lines);
  });

  return getTransfer(actor, id);
}
