import { Types } from 'mongoose';

import { paginate } from '../../lib/paginate.js';
import { dayIn, startOfDayIn } from '../../lib/period.js';
import { creditExposure } from '../../services/creditExposure.service.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { WholesaleOrder } from '../wholesaleOrder/wholesaleOrder.model.js';

import { AuditLog } from './auditLog.model.js';

import type { AuditLogDoc } from './auditLog.model.js';
import type { ListAuditQuery } from './audit.schema.js';
import type { PageMeta } from '@shared/types.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { CreditOverridesQuery } from '@shared/audit.js';
import type {
  AuditEntryPayload,
  CreditOverrideDashboard,
  CreditOverrideDealer,
  CreditOverrideRow,
} from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

const DAY = 86_400_000;

const toPayload = (a: AuditLogDoc): AuditEntryPayload => ({
  id: String(a._id),
  at: a.at.toISOString(),
  actorUserId: a.actorUserId ? String(a.actorUserId) : null,
  actorName: a.actorName,
  action: a.action,
  entity: a.entity,
  entityId: a.entityId ? String(a.entityId) : null,
  docNo: a.docNo,
  reason: a.reason,
  before: a.before,
  after: a.after,
  ip: a.ip,
  userAgent: a.userAgent,
  requestId: a.requestId,
});

/** `GET /audit` — the log, newest first. Read-only: nothing can change an entry. */
export async function listAudit(
  actor: RequestActor,
  query: ListAuditQuery,
): Promise<{ items: AuditEntryPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<AuditLogDoc> = { orgId: actor.orgId };
  if (query.action) filter.action = query.action;
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) filter.entityId = new Types.ObjectId(query.entityId);
  if (query.from || query.to) {
    const zone =
      (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
    filter.at = {
      ...(query.from ? { $gte: startOfDayIn(query.from, zone) } : {}),
      ...(query.to
        ? { $lt: new Date(startOfDayIn(query.to, zone).getTime() + 86_400_000) }
        : {}),
    };
  }
  const page = await paginate(AuditLog, {
    filter,
    query,
    sortable: ['at'],
    searchFields: ['docNo', 'reason', 'actorName'],
    defaultSort: { at: -1, _id: -1 },
  });
  return { items: page.items.map(toPayload), meta: page.meta };
}

/**
 * `GET /audit/credit-overrides` — the managers' dashboard (§8): every time someone lent past a
 * dealer's limit in the period, who did, why, and by how much; totals by approver; and each
 * dealer's position *now*, so a manager sees at a glance which overrides were paid back and which
 * dealers are still over.
 */
export async function creditOverrides(
  actor: RequestActor,
  query: CreditOverridesQuery,
): Promise<CreditOverrideDashboard> {
  const zone =
    (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
  const to = query.to ?? dayIn(new Date(), zone);
  const from = query.from ?? dayIn(new Date(startOfDayIn(to, zone).getTime() - 29 * DAY), zone);

  const entries = await AuditLog.find({
    orgId: actor.orgId,
    action: 'CREDIT_OVERRIDE',
    at: {
      $gte: startOfDayIn(from, zone),
      $lt: new Date(startOfDayIn(to, zone).getTime() + DAY),
    },
  })
    .sort({ at: -1, _id: -1 })
    .lean();

  const orderIds = [
    ...new Set(entries.flatMap((e) => (e.entityId ? [String(e.entityId)] : []))),
  ];
  const orders = await WholesaleOrder.find({
    orgId: actor.orgId,
    _id: { $in: orderIds.map((id) => new Types.ObjectId(id)) },
  })
    .select('status dealerPartyId')
    .lean();
  const orderBy = new Map(orders.map((o) => [String(o._id), o]));

  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const rows: CreditOverrideRow[] = entries.map((e) => {
    const b = e.before ?? {};
    const a = e.after ?? {};
    const order = e.entityId ? orderBy.get(String(e.entityId)) : undefined;
    const dealerPartyId =
      (typeof a.dealerPartyId === 'string' ? a.dealerPartyId : null) ??
      (order ? String(order.dealerPartyId) : null);
    return {
      id: String(e._id),
      at: e.at.toISOString(),
      stage: (b.stage as CreditOverrideRow['stage']) ?? 'CONFIRM',
      byUserId: e.actorUserId ? String(e.actorUserId) : null,
      byName: e.actorName,
      reason: e.reason ?? '',
      orderId: e.entityId ? String(e.entityId) : null,
      orderDocNo: e.docNo,
      orderStatus: order?.status ?? null,
      orderTotalMinor: num(a.orderTotalMinor),
      dealerPartyId,
      dealerName: null,
      limitMinor: num(b.limitMinor),
      exposureAfterMinor: num(b.exposureAfterMinor),
      shortfallMinor: num(b.shortfallMinor),
    };
  });

  const partyIds = [
    ...new Set(rows.flatMap((r) => (r.dealerPartyId ? [r.dealerPartyId] : []))),
  ];
  const parties = await Party.find({
    orgId: actor.orgId,
    _id: { $in: partyIds.map((id) => new Types.ObjectId(id)) },
  })
    .select('code name dealer.creditLimitMinor')
    .lean();
  const partyBy = new Map(parties.map((p) => [String(p._id), p]));
  for (const r of rows) r.dealerName = partyBy.get(r.dealerPartyId ?? '')?.name ?? null;

  const dealers: CreditOverrideDealer[] = [];
  for (const p of parties) {
    const exposure = await creditExposure(actor.orgId, p._id);
    const limitMinor = p.dealer?.creditLimitMinor ?? 0;
    dealers.push({
      partyId: String(p._id),
      name: p.name,
      code: p.code,
      overrides: rows.filter((r) => r.dealerPartyId === String(p._id)).length,
      limitMinor,
      exposureNowMinor: exposure.exposureMinor,
      overNowMinor: Math.max(0, exposure.exposureMinor - limitMinor),
    });
  }
  dealers.sort((x, y) => y.overNowMinor - x.overNowMinor || y.overrides - x.overrides);

  const approvers = new Map<string, CreditOverrideDashboard['byApprover'][number]>();
  for (const r of rows) {
    const k = r.byUserId ?? '';
    const cur = approvers.get(k) ?? {
      userId: r.byUserId,
      name: r.byName,
      count: 0,
      shortfallMinor: 0,
    };
    cur.count += 1;
    cur.shortfallMinor += r.shortfallMinor;
    approvers.set(k, cur);
  }

  return {
    from,
    to,
    count: rows.length,
    shortfallMinor: rows.reduce((t, r) => t + r.shortfallMinor, 0),
    byApprover: [...approvers.values()].sort((x, y) => y.count - x.count),
    dealers,
    rows,
  };
}
