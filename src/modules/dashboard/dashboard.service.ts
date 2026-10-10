import { dayIn } from '../../lib/period.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { ageingReport } from '../payment/ageing.service.js';
import { salesReport } from '../reports/reports.service.js';
import { reorderSuggestions } from '../supplierPo/reorder.service.js';
import { WholesaleOrder } from '../wholesaleOrder/wholesaleOrder.model.js';
import { orderCounts } from '../wholesaleOrder/wholesaleOrder.service.js';

import type { RequestActor } from '../../lib/requestUser.js';
import type { DashboardPayload } from '@shared/types.js';
import type { Types } from 'mongoose';

/**
 * The dashboard (Day 38) — a summary, never a second set of books. Every figure comes from the
 * function behind its report, called with that report's own period, so "today's sales" *is* the
 * sales report for today and "receivables" *is* the ageing report's total.
 */

const DAY = 86_400_000;
const PENDING = ['CONFIRMED', 'PICKING', 'PACKED', 'PARTIALLY_DISPATCHED'] as const;

/** `YYYY-MM-DD` shifted by whole days — calendar arithmetic on the org's own day strings. */
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export async function dashboard(actor: RequestActor): Promise<DashboardPayload> {
  const zone =
    (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
  const today = dayIn(new Date(), zone);
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(actor.user, p);

  const [sales, receivables, lowStock, dispatch] = await Promise.all([
    can('report:sales') ? salesSection(actor, today) : null,
    can('payment:read') ? receivablesSection(actor) : null,
    can('po:read') ? lowStockSection(actor) : null,
    can('order:read') ? dispatchSection(actor) : null,
  ]);
  return { today, sales, receivables, lowStock, dispatch };
}

async function salesSection(
  actor: RequestActor,
  today: string,
): Promise<DashboardPayload['sales']> {
  const from30 = addDays(today, -29);
  const [byChannel, month, wholesale, counter, dealers] = await Promise.all([
    salesReport(actor, { from: today, to: today, groupBy: 'channel' }),
    salesReport(actor, { to: today, groupBy: 'channel' }),
    salesReport(actor, { from: from30, to: today, groupBy: 'day', channel: 'WHOLESALE' }),
    salesReport(actor, { from: from30, to: today, groupBy: 'day', channel: 'COUNTER' }),
    salesReport(actor, { to: today, groupBy: 'dealer' }),
  ]);
  const net = (key: string) => byChannel.rows.find((r) => r.key === key)?.netMinor ?? 0;
  const w = new Map(wholesale.rows.map((r) => [r.key, r.netMinor]));
  const c = new Map(counter.rows.map((r) => [r.key, r.netMinor]));
  return {
    todayNetMinor: byChannel.totals.netMinor,
    todayWholesaleMinor: net('WHOLESALE'),
    todayCounterMinor: net('COUNTER'),
    todayInvoices: byChannel.totals.invoices,
    monthNetMinor: month.totals.netMinor,
    trend: Array.from({ length: 30 }, (_, i) => {
      const day = addDays(from30, i);
      return { day, wholesaleMinor: w.get(day) ?? 0, counterMinor: c.get(day) ?? 0 };
    }),
    topDealers: dealers.rows
      .filter((r) => r.key !== 'walk-in' && r.netMinor > 0)
      .slice(0, 5)
      .map((r) => ({
        partyId: r.key,
        name: r.label,
        netMinor: r.netMinor,
        invoices: r.invoices,
      })),
  };
}

async function receivablesSection(
  actor: RequestActor,
): Promise<DashboardPayload['receivables']> {
  const a = await ageingReport(actor, {});
  const overdue = a.rows
    .map((r) => ({
      partyId: r.partyId,
      name: r.name,
      overdueMinor: r.totalMinor - r.buckets.CURRENT,
      oldestDays: r.oldestDays,
    }))
    .filter((r) => r.overdueMinor > 0);
  return {
    totalMinor: a.totalMinor,
    overdueMinor: a.totalMinor - a.totals.CURRENT,
    overdueDealers: overdue.length,
    alerts: overdue.slice(0, 5),
  };
}

async function lowStockSection(actor: RequestActor): Promise<DashboardPayload['lowStock']> {
  const s = await reorderSuggestions(actor, {});
  return {
    count: s.length,
    items: s.slice(0, 5).map((x) => ({
      productId: x.productId,
      sku: x.sku,
      name: x.name,
      positionBase: x.positionBase,
      reorderPoint: x.reorderPoint,
    })),
  };
}

async function dispatchSection(actor: RequestActor): Promise<DashboardPayload['dispatch']> {
  const counts = await orderCounts(actor, {});
  const scope = locationScopeOf(actor.user);
  const oldest = await WholesaleOrder.find({
    orgId: actor.orgId,
    isDeleted: false,
    status: { $in: PENDING },
    ...(scope ? { locationId: { $in: scope } } : {}),
  })
    .sort({ orderDate: 1, _id: 1 })
    .limit(5)
    .select('docNo dealerPartyId orderDate requiredDate status')
    .lean();
  const parties = await Party.find({
    orgId: actor.orgId,
    _id: { $in: oldest.map((o) => o.dealerPartyId) },
  })
    .select('name displayName')
    .lean();
  const nameOf = new Map(parties.map((p) => [String(p._id), p.displayName ?? p.name]));
  return {
    pendingOrders: PENDING.reduce((t, s) => t + counts.byStatus[s], 0),
    oldest: oldest.map((o) => ({
      id: String(o._id),
      docNo: o.docNo,
      dealerName: nameOf.get(String(o.dealerPartyId as Types.ObjectId)) ?? null,
      orderDate: o.orderDate.toISOString(),
      requiredDate: o.requiredDate ? o.requiredDate.toISOString() : null,
      status: o.status,
    })),
  };
}
