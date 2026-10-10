import { Types } from 'mongoose';

import { dayIn, startOfDayIn } from '../../lib/period.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { lineNames } from '../../services/stockLines.js';
import { Dispatch } from '../dispatch/dispatch.model.js';
import { Invoice } from '../invoice/invoice.model.js';
import { LedgerEntry } from '../ledger/ledgerEntry.model.js';
import { Location } from '../location/location.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';
import { PosSession } from '../pos/posSession.model.js';
import { Product } from '../product/product.model.js';
import { SalesReturn } from '../salesReturn/salesReturn.model.js';
import { StockBalance } from '../stock/stockBalance.model.js';
import { StockLedger } from '../stock/stockLedger.model.js';
import { User } from '../user/user.model.js';
import { Brand } from '../brand/brand.model.js';

import type { RequestActor } from '../../lib/requestUser.js';
import type { InvoiceDoc } from '../invoice/invoice.model.js';
import type {
  CollectionRegisterQuery,
  DeadStockQuery,
  PeriodQuery,
  SalesReportQuery,
  StockValuationQuery,
} from '@shared/reports.js';
import type {
  CollectionRegister,
  DeadStock,
  DispatchRegister,
  ReportTie,
  SalesReport,
  SalesReportRow,
  ShiftSummary,
  StockValuation,
} from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * The report suite (Day 37). Read-only, and computed from the documents themselves — invoices,
 * returns, balances, challans, receipts, shifts — never from a stored summary that could drift.
 *
 * Every report:
 *   - is scoped: a user tied to locations sees only theirs (an explicit `locationId` must be one
 *     of them — `requireLocation` on the route);
 *   - hides cost and margin from anyone without `stock:viewCost` (margin also needs `report:profit`);
 *   - carries **ties**: its total recomputed from the ledger underneath, so a figure that does not
 *     agree is visible on the screen rather than discovered at the year end.
 */

const DAY = 86_400_000;
const oid = (id: string) => new Types.ObjectId(id);

async function periodOf(actor: RequestActor, q: { from?: string; to?: string }) {
  const zone =
    (await Org.findById(actor.orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';
  const to = q.to ?? dayIn(new Date(), zone);
  const from = q.from ?? `${to.slice(0, 8)}01`;
  return {
    zone,
    from,
    to,
    start: startOfDayIn(from, zone),
    end: new Date(startOfDayIn(to, zone).getTime() + DAY),
  };
}

/** The locations a report may read: the one asked for, else the caller's, else all (null). */
function locationsOf(actor: RequestActor, locationId?: string): Types.ObjectId[] | null {
  if (locationId) return [oid(locationId)];
  const scope = locationScopeOf(actor.user);
  return scope ? scope.map(oid) : null;
}

const tie = (label: string, reportMinor: number, ledgerMinor: number): ReportTie => ({
  label,
  reportMinor,
  ledgerMinor,
  matches: reportMinor === ledgerMinor,
});

async function namesOf<T extends { _id: Types.ObjectId }>(
  find: Promise<T[]>,
  pick: (d: T) => string,
): Promise<Map<string, string>> {
  return new Map((await find).map((d) => [String(d._id), pick(d)]));
}

// ─── Sales: by dealer / product / brand / salesperson / channel / day / month ────────────

type Line = InvoiceDoc['lines'][number] & { _id: Types.ObjectId };

export async function salesReport(
  actor: RequestActor,
  query: SalesReportQuery,
): Promise<SalesReport> {
  const p = await periodOf(actor, query);
  const locations = locationsOf(actor, query.locationId);
  const seesMargin =
    hasPermission(actor.user, 'stock:viewCost') && hasPermission(actor.user, 'report:profit');

  const invoiceFilter: FilterQuery<InvoiceDoc> = {
    orgId: actor.orgId,
    status: 'POSTED',
    series: { $ne: 'OB' },
    invoiceDate: { $gte: p.start, $lt: p.end },
  };
  if (locations) invoiceFilter.locationId = { $in: locations };
  if (query.channel) invoiceFilter.channel = query.channel;
  const returnFilter: FilterQuery<unknown> = {
    orgId: actor.orgId,
    status: 'POSTED',
    postedAt: { $gte: p.start, $lt: p.end },
  };
  if (locations) returnFilter.locationId = { $in: locations };
  if (query.channel) returnFilter.channel = query.channel;

  const [invoices, returns] = await Promise.all([
    Invoice.find(invoiceFilter)
      .select(
        'channel partyId partySnapshot walkInName salespersonUserId invoiceDate lines grandTotalMinor shippingMinor roundingMinor taxMinor',
      )
      .lean(),
    SalesReturn.find(returnFilter).lean(),
  ]);
  // A return is grouped like the sale it reverses: same salesperson, same cost per unit.
  const sourceIds = [...new Set(returns.map((r) => String(r.invoiceId)))];
  const sources = await Invoice.find({ orgId: actor.orgId, _id: { $in: sourceIds } })
    .select('salespersonUserId lines._id lines.costAtSaleMinor')
    .lean();
  const sourceBy = new Map(sources.map((s) => [String(s._id), s]));

  const productIds = [
    ...new Set([
      ...invoices.flatMap((i) => i.lines.map((l) => String(l.productId))),
      ...returns.flatMap((r) => r.lines.map((l) => String(l.productId))),
    ]),
  ];
  const products = await Product.find({ orgId: actor.orgId, _id: { $in: productIds } })
    .select('sku name brandId')
    .lean();
  const productBy = new Map(products.map((x) => [String(x._id), x]));
  const brandNames = await namesOf(
    Brand.find({
      orgId: actor.orgId,
      _id: { $in: products.flatMap((x) => (x.brandId ? [x.brandId] : [])) },
    })
      .select('name')
      .lean(),
    (b) => b.name,
  );
  const userNames = await namesOf(
    User.find({
      orgId: actor.orgId,
      _id: {
        $in: [...invoices, ...sources].flatMap((i) =>
          i.salespersonUserId ? [i.salespersonUserId] : [],
        ),
      },
    })
      .select('name')
      .lean(),
    (u) => u.name,
  );

  type Acc = Omit<SalesReportRow, 'marginMinor' | 'marginPct' | 'costMinor'> & {
    costMinor: number;
    invoiceIds: Set<string>;
  };
  const rows = new Map<string, Acc>();
  const acc = (key: string, label: string, sublabel: string | null = null): Acc => {
    let r = rows.get(key);
    if (!r) {
      r = {
        key,
        label,
        sublabel,
        invoices: 0,
        qtyBase: 0,
        salesMinor: 0,
        returnsMinor: 0,
        netMinor: 0,
        costMinor: 0,
        invoiceIds: new Set(),
      };
      rows.set(key, r);
    }
    return r;
  };
  const productKey = (productId: Types.ObjectId) => {
    const x = productBy.get(String(productId));
    return {
      key: String(productId),
      label: x?.name ?? '(deleted product)',
      sublabel: x?.sku ?? null,
    };
  };
  const brandKey = (productId: Types.ObjectId) => {
    const b = productBy.get(String(productId))?.brandId;
    return b
      ? {
          key: String(b),
          label: brandNames.get(String(b)) ?? '(deleted brand)',
          sublabel: null,
        }
      : { key: 'none', label: 'No brand', sublabel: null };
  };
  const salespersonKey = (id: Types.ObjectId | null) =>
    id
      ? { key: String(id), label: userNames.get(String(id)) ?? '(former user)', sublabel: null }
      : { key: 'none', label: 'No salesperson', sublabel: null };
  const partyKey = (partyId: Types.ObjectId | null, name: string | null) =>
    partyId
      ? { key: String(partyId), label: name ?? '(party)', sublabel: null }
      : { key: 'walk-in', label: 'Walk-in customers', sublabel: null };
  const dateKey = (d: Date) => {
    const dd = dayIn(d, p.zone);
    return query.groupBy === 'month'
      ? { key: dd.slice(0, 7), label: dd.slice(0, 7), sublabel: null }
      : { key: dd, label: dd, sublabel: null };
  };

  let uncostedLines = 0;
  for (const inv of invoices) {
    const head = (): { key: string; label: string; sublabel: string | null } | null => {
      switch (query.groupBy) {
        case 'dealer':
          return partyKey(inv.partyId, inv.partySnapshot?.name ?? inv.walkInName ?? null);
        case 'salesperson':
          return salespersonKey(inv.salespersonUserId);
        case 'channel':
          return {
            key: inv.channel,
            label: inv.channel === 'WHOLESALE' ? 'Wholesale' : 'Counter',
            sublabel: null,
          };
        case 'day':
        case 'month':
          return dateKey(inv.invoiceDate);
        default:
          return null; // per line
      }
    };
    const h = head();
    for (const l of inv.lines as Line[]) {
      const k =
        h ?? (query.groupBy === 'product' ? productKey(l.productId) : brandKey(l.productId));
      const r = acc(k.key, k.label, k.sublabel);
      r.invoiceIds.add(String(inv._id));
      r.qtyBase += l.qtyBase;
      r.salesMinor += l.lineTotalMinor;
      if (l.costAtSaleMinor == null) uncostedLines += 1;
      r.costMinor += (l.costAtSaleMinor ?? 0) * l.qtyBase;
    }
  }
  for (const ret of returns) {
    const src = sourceBy.get(String(ret.invoiceId));
    const costOf = (lineId: Types.ObjectId) =>
      (src?.lines as Line[] | undefined)?.find((x) => x._id.equals(lineId))?.costAtSaleMinor ??
      0;
    for (const l of ret.lines) {
      const k =
        query.groupBy === 'dealer'
          ? partyKey(ret.partyId, ret.customerName)
          : query.groupBy === 'salesperson'
            ? salespersonKey(src?.salespersonUserId ?? null)
            : query.groupBy === 'channel'
              ? {
                  key: ret.channel,
                  label: ret.channel === 'WHOLESALE' ? 'Wholesale' : 'Counter',
                  sublabel: null,
                }
              : query.groupBy === 'day' || query.groupBy === 'month'
                ? dateKey(ret.postedAt)
                : query.groupBy === 'product'
                  ? productKey(l.productId)
                  : brandKey(l.productId);
      const r = acc(k.key, k.label, k.sublabel);
      r.qtyBase -= l.qtyBase;
      r.returnsMinor += l.lineTotalMinor;
      r.costMinor -= costOf(l.invoiceLineId) * l.qtyBase;
    }
  }

  const finish = (r: Acc): SalesReportRow => {
    const netMinor = r.salesMinor - r.returnsMinor;
    const marginMinor = netMinor - r.costMinor;
    return {
      key: r.key,
      label: r.label,
      sublabel: r.sublabel,
      invoices: r.invoiceIds.size,
      qtyBase: r.qtyBase,
      salesMinor: r.salesMinor,
      returnsMinor: r.returnsMinor,
      netMinor,
      costMinor: seesMargin ? r.costMinor : null,
      marginMinor: seesMargin ? marginMinor : null,
      marginPct:
        seesMargin && netMinor ? Math.round((marginMinor / netMinor) * 1000) / 10 : null,
    };
  };
  const all = [...rows.values()];
  const out = all.map(finish);
  const dated = query.groupBy === 'day' || query.groupBy === 'month';
  out.sort((a, b) => (dated ? a.key.localeCompare(b.key) : b.netMinor - a.netMinor));
  const total = finish(
    all.reduce<Acc>(
      (t, r) => {
        r.invoiceIds.forEach((id) => t.invoiceIds.add(id));
        t.qtyBase += r.qtyBase;
        t.salesMinor += r.salesMinor;
        t.returnsMinor += r.returnsMinor;
        t.costMinor += r.costMinor;
        return t;
      },
      {
        key: '',
        label: '',
        sublabel: null,
        invoices: 0,
        qtyBase: 0,
        salesMinor: 0,
        returnsMinor: 0,
        netMinor: 0,
        costMinor: 0,
        invoiceIds: new Set(),
      },
    ),
  );
  const { key: _k, label: _l, sublabel: _s, ...totals } = total;

  // ── Ties: lines + shipping + rounding + tax = what the invoices say; returns = their notes ──
  const header = invoices.reduce(
    (t, i) => ({
      grand: t.grand + i.grandTotalMinor,
      extra: t.extra + (i.shippingMinor ?? 0) + (i.roundingMinor ?? 0) + (i.taxMinor ?? 0),
    }),
    { grand: 0, extra: 0 },
  );
  return {
    from: p.from,
    to: p.to,
    groupBy: query.groupBy,
    rows: out,
    totals,
    costHidden: !seesMargin,
    uncostedLines,
    ties: [
      tie(
        'Invoice lines + shipping + rounding = invoice totals',
        totals.salesMinor + header.extra,
        header.grand,
      ),
      tie(
        'Returns = sales return documents',
        totals.returnsMinor,
        returns.reduce((t, r) => t + r.grandTotalMinor, 0),
      ),
    ],
  };
}

// ─── Stock valuation ────────────────────────────────────────────────────────────────────

export async function stockValuation(
  actor: RequestActor,
  query: StockValuationQuery,
): Promise<StockValuation> {
  const locations = locationsOf(actor, query.locationId);
  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const filter: FilterQuery<unknown> = { orgId: actor.orgId, qtyOnHand: { $ne: 0 } };
  if (locations) filter.locationId = { $in: locations };
  if (query.q) {
    const rx = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const ids = await Product.find({ orgId: actor.orgId, $or: [{ sku: rx }, { name: rx }] })
      .select('_id')
      .lean();
    filter.productId = { $in: ids.map((x) => x._id) };
  }
  const balances = await StockBalance.find(filter)
    .select('locationId productId variantId qtyOnHand qtyReserved avgCostMinor')
    .lean();
  const [names, locationNames] = await Promise.all([
    lineNames(actor.orgId, balances),
    namesOf(
      Location.find({ orgId: actor.orgId, _id: { $in: balances.map((b) => b.locationId) } })
        .select('name')
        .lean(),
      (l) => l.name,
    ),
  ]);

  const byLocation = query.groupBy === 'location';
  const rows = new Map<string, StockValuation['rows'][number] & { value: number }>();
  for (const b of balances) {
    const key = `${String(b.productId)}|${String(b.variantId)}${byLocation ? `|${String(b.locationId)}` : ''}`;
    const n = names(b);
    const r = rows.get(key) ?? {
      key,
      productId: String(b.productId),
      sku: n.sku ?? '',
      name: n.productName ?? '',
      variantLabel: n.variantLabel ?? null,
      locationName: byLocation ? (locationNames.get(String(b.locationId)) ?? null) : null,
      baseUom: n.baseUom ?? '',
      qtyOnHand: 0,
      qtyReserved: 0,
      avgCostMinor: null,
      valueMinor: null,
      value: 0,
    };
    r.qtyOnHand += b.qtyOnHand;
    r.qtyReserved += b.qtyReserved;
    r.value += b.qtyOnHand * (b.avgCostMinor ?? 0);
    rows.set(key, r);
  }
  const out = [...rows.values()]
    .map(({ value, ...r }) => ({
      ...r,
      avgCostMinor: seesCost && r.qtyOnHand ? Math.round(value / r.qtyOnHand) : null,
      valueMinor: seesCost ? value : null,
    }))
    .sort((a, b) => (b.valueMinor ?? 0) - (a.valueMinor ?? 0) || a.sku.localeCompare(b.sku));
  const qtyOnHand = out.reduce((t, r) => t + r.qtyOnHand, 0);

  // The balances are a cache of the stock ledger: their quantities must be its sum.
  const ledgerFilter: FilterQuery<unknown> = { orgId: actor.orgId };
  if (locations) ledgerFilter.locationId = { $in: locations };
  if (filter.productId) ledgerFilter.productId = filter.productId;
  const [ledger] = await StockLedger.aggregate<{ n: number }>([
    { $match: ledgerFilter },
    { $group: { _id: null, n: { $sum: '$qtyBase' } } },
  ]);
  return {
    rows: out,
    totals: {
      qtyOnHand,
      items: out.length,
      valueMinor: seesCost ? out.reduce((t, r) => t + (r.valueMinor ?? 0), 0) : null,
    },
    costHidden: !seesCost,
    ties: [tie('Units on hand = sum of the stock ledger', qtyOnHand, ledger?.n ?? 0)],
  };
}

// ─── Dispatch register ──────────────────────────────────────────────────────────────────

export async function dispatchRegister(
  actor: RequestActor,
  query: PeriodQuery,
): Promise<DispatchRegister> {
  const p = await periodOf(actor, query);
  const locations = locationsOf(actor, query.locationId);
  const filter: FilterQuery<unknown> = {
    orgId: actor.orgId,
    status: { $in: ['DISPATCHED', 'DELIVERED'] },
    dispatchedAt: { $gte: p.start, $lt: p.end },
  };
  if (locations) filter.locationId = { $in: locations };
  const docs = await Dispatch.find(filter).sort({ dispatchedAt: 1, _id: 1 }).lean();
  const [dealers, locationNames, invoices] = await Promise.all([
    namesOf(
      Party.find({ orgId: actor.orgId, _id: { $in: docs.map((d) => d.dealerPartyId) } })
        .select('name displayName')
        .lean(),
      (x) => x.displayName ?? x.name,
    ),
    namesOf(
      Location.find({ orgId: actor.orgId, _id: { $in: docs.map((d) => d.locationId) } })
        .select('name')
        .lean(),
      (l) => l.name,
    ),
    Invoice.find({
      orgId: actor.orgId,
      _id: { $in: docs.flatMap((d) => (d.invoiceId ? [d.invoiceId] : [])) },
    })
      .select('grandTotalMinor')
      .lean(),
  ]);
  const invoiceTotal = new Map(invoices.map((i) => [String(i._id), i.grandTotalMinor]));
  const rows = docs.map((d) => {
    const t = d.transport;
    return {
      id: String(d._id),
      docNo: d.docNo ?? '',
      dispatchedAt: d.dispatchedAt!.toISOString(),
      orderDocNo: d.orderDocNo,
      dealerName: dealers.get(String(d.dealerPartyId)) ?? null,
      locationName: locationNames.get(String(d.locationId)) ?? null,
      qtyBase: d.lines.reduce((s, l) => s + l.qtyBase, 0),
      invoiceDocNo: d.invoiceDocNo,
      invoiceMinor: d.invoiceId ? (invoiceTotal.get(String(d.invoiceId)) ?? null) : null,
      transport: t
        ? [t.mode, t.vehicleNo, t.courierName, t.trackingNo].filter(Boolean).join(' · ')
        : null,
      status: d.status,
      deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
    };
  });
  const qtyBase = rows.reduce((t, r) => t + r.qtyBase, 0);
  const [moved] = docs.length
    ? await StockLedger.aggregate<{ n: number }>([
        {
          $match: {
            orgId: actor.orgId,
            refId: { $in: docs.map((d) => d._id) },
            movementType: 'SALE',
          },
        },
        { $group: { _id: null, n: { $sum: '$qtyBase' } } },
      ])
    : [];
  return {
    from: p.from,
    to: p.to,
    rows,
    totals: {
      dispatches: rows.length,
      qtyBase,
      invoiceMinor: rows.reduce((t, r) => t + (r.invoiceMinor ?? 0), 0),
      delivered: rows.filter((r) => r.status === 'DELIVERED').length,
    },
    ties: [
      tie('Units dispatched = SALE movements in the stock ledger', qtyBase, -(moved?.n ?? 0)),
    ],
  };
}

// ─── Collection register ────────────────────────────────────────────────────────────────

export async function collectionRegister(
  actor: RequestActor,
  query: CollectionRegisterQuery,
): Promise<CollectionRegister> {
  const p = await periodOf(actor, query);
  const locations = locationsOf(actor, query.locationId);
  // Dealer receipts: money in, outside a shift (the till's takings are the shift summary).
  const filter: FilterQuery<unknown> = {
    orgId: actor.orgId,
    series: 'RCPT',
    direction: 'IN',
    status: 'POSTED',
    posSessionId: null,
    paidAt: { $gte: p.start, $lt: p.end },
  };
  if (locations) filter.$or = [{ locationId: { $in: locations } }, { locationId: null }];
  if (query.method) filter.method = query.method;
  const docs = await PaymentDoc.find(filter).sort({ paidAt: 1, _id: 1 }).lean();
  const parties = await namesOf(
    Party.find({
      orgId: actor.orgId,
      _id: { $in: docs.flatMap((d) => (d.partyId ? [d.partyId] : [])) },
    })
      .select('name displayName')
      .lean(),
    (x) => x.displayName ?? x.name,
  );
  const rows = docs.map((d) => ({
    id: String(d._id),
    docNo: d.docNo,
    paidAt: d.paidAt.toISOString(),
    partyName: d.partyId ? (parties.get(String(d.partyId)) ?? null) : null,
    method: d.method,
    reference: d.instrument?.chequeNo ?? d.mfs?.trxId ?? d.reference ?? null,
    chequeStatus: d.instrument?.status ?? null,
    amountMinor: d.amountMinor,
    allocatedMinor: d.allocatedMinor,
    unallocatedMinor: d.unallocatedMinor,
  }));
  // Money in hand: everything except cheques not yet cleared (or bounced).
  const counts = (r: (typeof rows)[number]) => !r.chequeStatus || r.chequeStatus === 'CLEARED';
  const byMethod = new Map<string, { method: string; count: number; amountMinor: number }>();
  for (const r of rows) {
    const m = byMethod.get(r.method) ?? { method: r.method, count: 0, amountMinor: 0 };
    m.count += 1;
    m.amountMinor += counts(r) ? r.amountMinor : 0;
    byMethod.set(r.method, m);
  }
  const amountMinor = rows.filter(counts).reduce((t, r) => t + r.amountMinor, 0);
  const [ledger] = docs.length
    ? await LedgerEntry.aggregate<{ n: number }>([
        {
          $match: {
            orgId: actor.orgId,
            docType: 'RECEIPT',
            refId: { $in: docs.map((d) => d._id) },
          },
        },
        { $group: { _id: null, n: { $sum: '$creditMinor' } } },
      ])
    : [];
  return {
    from: p.from,
    to: p.to,
    rows,
    byMethod: [...byMethod.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    totals: {
      count: rows.length,
      amountMinor,
      pendingChequesMinor: rows
        .filter((r) => !counts(r) && r.chequeStatus !== 'BOUNCED')
        .reduce((t, r) => t + r.amountMinor, 0),
    },
    ties: [tie('Collected = RECEIPT credits on the party ledger', amountMinor, ledger?.n ?? 0)],
  };
}

// ─── POS shift summary ──────────────────────────────────────────────────────────────────

export async function shiftSummary(
  actor: RequestActor,
  query: PeriodQuery,
): Promise<ShiftSummary> {
  const p = await periodOf(actor, query);
  const locations = locationsOf(actor, query.locationId);
  const filter: FilterQuery<unknown> = {
    orgId: actor.orgId,
    status: 'CLOSED',
    closedAt: { $gte: p.start, $lt: p.end },
  };
  if (locations) filter.locationId = { $in: locations };
  const docs = await PosSession.find(filter).sort({ closedAt: 1 }).lean();
  const [users, locationNames] = await Promise.all([
    namesOf(
      User.find({
        orgId: actor.orgId,
        _id: {
          $in: docs.flatMap((d) => [
            d.openedByUserId,
            ...(d.closedByUserId ? [d.closedByUserId] : []),
          ]),
        },
      })
        .select('name')
        .lean(),
      (u) => u.name,
    ),
    namesOf(
      Location.find({ orgId: actor.orgId, _id: { $in: docs.map((d) => d.locationId) } })
        .select('name')
        .lean(),
      (l) => l.name,
    ),
  ]);
  const rows = docs.map((d) => ({
    id: String(d._id),
    terminalCode: d.terminalCode,
    locationName: locationNames.get(String(d.locationId)) ?? null,
    openedBy: users.get(String(d.openedByUserId)) ?? null,
    closedBy: d.closedByUserId ? (users.get(String(d.closedByUserId)) ?? null) : null,
    openedAt: d.openedAt.toISOString(),
    closedAt: d.closedAt ? d.closedAt.toISOString() : null,
    salesCount: d.totals?.salesCount ?? 0,
    grossMinor: d.totals?.grossMinor ?? 0,
    discountMinor: d.totals?.discountMinor ?? 0,
    returnsMinor: d.totals?.returnsMinor ?? 0,
    netMinor: d.totals?.netMinor ?? 0,
    expectedCashMinor: d.expectedCashMinor,
    countedCashMinor: d.countedCashMinor,
    varianceMinor: d.varianceMinor,
    byMethod: d.totals?.byMethod ?? [],
  }));
  // A shift's sales are its counter invoices: the Z-report figure must be theirs.
  const [inv] = docs.length
    ? await Invoice.aggregate<{ n: number; c: number }>([
        {
          $match: {
            orgId: actor.orgId,
            status: 'POSTED',
            posSessionId: { $in: docs.map((d) => d._id) },
          },
        },
        { $group: { _id: null, n: { $sum: '$grandTotalMinor' }, c: { $sum: 1 } } },
      ])
    : [];
  const salesCount = rows.reduce((t, r) => t + r.salesCount, 0);
  return {
    from: p.from,
    to: p.to,
    rows,
    totals: {
      shifts: rows.length,
      salesCount,
      netMinor: rows.reduce((t, r) => t + r.netMinor, 0),
      returnsMinor: rows.reduce((t, r) => t + r.returnsMinor, 0),
      varianceMinor: rows.reduce((t, r) => t + (r.varianceMinor ?? 0), 0),
    },
    ties: [tie('Sales counted = counter invoices of these shifts', salesCount, inv?.c ?? 0)],
  };
}

// ─── Dead stock ─────────────────────────────────────────────────────────────────────────

export async function deadStock(
  actor: RequestActor,
  query: DeadStockQuery,
): Promise<DeadStock> {
  const locations = locationsOf(actor, query.locationId);
  const seesCost = hasPermission(actor.user, 'stock:viewCost');
  const filter: FilterQuery<unknown> = { orgId: actor.orgId, qtyOnHand: { $gt: 0 } };
  if (locations) filter.locationId = { $in: locations };
  const balances = await StockBalance.find(filter)
    .select('locationId productId variantId qtyOnHand avgCostMinor')
    .lean();
  const saleMatch: FilterQuery<unknown> = {
    orgId: actor.orgId,
    movementType: 'SALE',
    productId: { $in: [...new Set(balances.map((b) => String(b.productId)))].map(oid) },
  };
  if (locations) saleMatch.locationId = { $in: locations };
  const [lastSales, names, locationNames] = await Promise.all([
    StockLedger.aggregate<{
      _id: { p: Types.ObjectId; v: Types.ObjectId | null; l: Types.ObjectId };
      at: Date;
    }>([
      { $match: saleMatch },
      {
        $group: {
          _id: { p: '$productId', v: '$variantId', l: '$locationId' },
          at: { $max: '$postedAt' },
        },
      },
    ]),
    lineNames(actor.orgId, balances),
    namesOf(
      Location.find({ orgId: actor.orgId, _id: { $in: balances.map((b) => b.locationId) } })
        .select('name')
        .lean(),
      (l) => l.name,
    ),
  ]);
  const lastBy = new Map(
    lastSales.map((s) => [
      `${String(s._id.p)}|${String(s._id.v ?? null)}|${String(s._id.l)}`,
      s.at,
    ]),
  );
  const now = Date.now();
  const cutoff = now - query.days * DAY;
  const rows = balances
    .flatMap((b) => {
      const key = `${String(b.productId)}|${String(b.variantId ?? null)}|${String(b.locationId)}`;
      const last = lastBy.get(key) ?? null;
      if (last && last.getTime() >= cutoff) return [];
      const n = names(b);
      return [
        {
          key,
          productId: String(b.productId),
          sku: n.sku ?? '',
          name: n.productName ?? '',
          variantLabel: n.variantLabel ?? null,
          locationName: locationNames.get(String(b.locationId)) ?? null,
          baseUom: n.baseUom ?? '',
          qtyOnHand: b.qtyOnHand,
          lastSoldAt: last ? last.toISOString() : null,
          daysSinceSale: last ? Math.floor((now - last.getTime()) / DAY) : null,
          valueMinor: seesCost ? b.qtyOnHand * (b.avgCostMinor ?? 0) : null,
        },
      ];
    })
    .sort((a, b) => (b.valueMinor ?? 0) - (a.valueMinor ?? 0) || b.qtyOnHand - a.qtyOnHand);
  return {
    days: query.days,
    rows,
    totals: {
      items: rows.length,
      qtyOnHand: rows.reduce((t, r) => t + r.qtyOnHand, 0),
      valueMinor: seesCost ? rows.reduce((t, r) => t + (r.valueMinor ?? 0), 0) : null,
    },
    costHidden: !seesCost,
  };
}
