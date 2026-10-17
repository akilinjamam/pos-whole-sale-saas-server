import { hasPermission } from '../../middleware/requirePermission.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { expiringLots } from '../lot/lot.service.js';
import { ageingReport } from '../payment/ageing.service.js';
import { reorderSuggestions } from '../supplierPo/reorder.service.js';
import { WholesaleOrder } from '../wholesaleOrder/wholesaleOrder.model.js';
import { formatMoney } from '../../shared/money.js';
import { orgAccess } from '../../services/subscription.service.js';
import { planHasFeature, REMINDER_DAYS } from '../../domain/subscription.js';

import type { RequestActor } from '../../lib/requestUser.js';
import type { OrgAccess } from '../../services/subscription.service.js';
import type { NotificationPayload, NotificationsPayload } from '@shared/types.js';

/**
 * Notifications (Day 39): low stock, lots expired or about to, dealers past their terms, orders
 * waiting for a manager. Each is asked of the function behind its screen, and only of what the
 * caller may see — a store keeper is told about expiry, not about overdue dealers.
 *
 * SaaS phase 6 adds the business's own subscription — trial or paid period ending within a week,
 * payment due, read-only — for those who can choose the plan (`org:update`). Everyone else already
 * sees the banner.
 */

/** The subscription notice, if there is one worth a bell — null otherwise. */
export function subscriptionNotification(access: OrgAccess): NotificationPayload | null {
  const { status, access: level, daysLeft } = access.state;
  const to = '/settings/subscription';
  if (level === 'READ_ONLY') {
    return {
      kind: 'SUBSCRIPTION',
      severity: 'critical',
      title: 'Your account is read-only',
      detail: 'Payment is overdue. Changes are paused until it is recorded.',
      count: 1,
      to,
    };
  }
  if (status === 'PAST_DUE') {
    return {
      kind: 'SUBSCRIPTION',
      severity: 'critical',
      title: 'Payment is due',
      detail: `Read-only in ${daysLeft ?? 0} day(s) unless payment is recorded.`,
      count: 1,
      to,
    };
  }
  if ((status === 'TRIAL' || status === 'ACTIVE') && daysLeft !== null) {
    if (daysLeft > Math.max(...REMINDER_DAYS)) return null;
    const what = status === 'TRIAL' ? 'Free trial' : 'Subscription';
    return {
      kind: 'SUBSCRIPTION',
      severity: daysLeft <= 3 ? 'critical' : 'warning',
      title: `${what} ends in ${daysLeft} day(s)`,
      detail: 'Choose a plan and pay to keep working without a break.',
      count: 1,
      to,
    };
  }
  return null;
}

/** Lots expiring within this many days are a warning; already expired, critical. */
export const EXPIRY_WARNING_DAYS = 30;

export async function notifications(actor: RequestActor): Promise<NotificationsPayload> {
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(actor.user, p);
  const scope = locationScopeOf(actor.user);
  const [reorder, lots, ageing, approvals, access] = await Promise.all([
    can('po:read') ? reorderSuggestions(actor, {}) : null,
    can('stock:read') ? expiringLots(actor, { withinDays: EXPIRY_WARNING_DAYS }) : null,
    can('payment:read') ? ageingReport(actor, {}) : null,
    can('order:approve')
      ? WholesaleOrder.countDocuments({
          orgId: actor.orgId,
          isDeleted: false,
          status: 'PENDING_APPROVAL',
          ...(scope ? { locationId: { $in: scope } } : {}),
        })
      : null,
    // Cached per business; needed for the subscription notice and to know whether the plan has
    // the Reorder screen to point the low-stock notice at.
    orgAccess(actor.orgId),
  ]);

  const items: NotificationPayload[] = [];
  const subscription = can('org:update') ? subscriptionNotification(access) : null;
  if (subscription) items.push(subscription);
  if (lots) {
    const expired = lots.filter((l) => (l.daysToExpiry ?? 0) < 0);
    const soon = lots.filter((l) => (l.daysToExpiry ?? 0) >= 0);
    if (expired.length) {
      items.push({
        kind: 'EXPIRED',
        severity: 'critical',
        title: `${expired.length} lot(s) expired, still in stock`,
        detail: expired
          .slice(0, 3)
          .map((l) => `${l.sku} ${l.lotNo}`)
          .join(' · '),
        count: expired.length,
        to: '/inventory/expiry?within=30',
      });
    }
    if (soon.length) {
      items.push({
        kind: 'EXPIRING',
        severity: 'warning',
        title: `${soon.length} lot(s) expire within ${EXPIRY_WARNING_DAYS} days`,
        detail: soon
          .slice(0, 3)
          .map((l) => `${l.sku} ${l.lotNo} (${l.daysToExpiry}d)`)
          .join(' · '),
        count: soon.length,
        to: '/inventory/expiry?within=30',
      });
    }
  }
  if (ageing) {
    const overdue = ageing.rows.filter((r) => r.totalMinor - r.buckets.CURRENT > 0);
    if (overdue.length) {
      const amount = ageing.totalMinor - ageing.totals.CURRENT;
      items.push({
        kind: 'OVERDUE',
        severity: overdue.some((r) => r.oldestDays > 60) ? 'critical' : 'warning',
        title: `${overdue.length} dealer(s) overdue — ${formatMoney(amount, { symbol: '৳' })}`,
        detail: overdue
          .slice(0, 3)
          .map((r) => `${r.name} (${r.oldestDays}d)`)
          .join(' · '),
        count: overdue.length,
        to: '/receivables/ageing',
      });
    }
  }
  if (reorder?.length) {
    items.push({
      kind: 'LOW_STOCK',
      severity: reorder.some((r) => r.positionBase <= 0) ? 'critical' : 'warning',
      title: `${reorder.length} product(s) below reorder point`,
      detail: reorder
        .slice(0, 3)
        .map((r) => r.sku)
        .join(' · '),
      count: reorder.length,
      // Reorder suggestions come with purchase orders (plan feature PURCHASING); without them, the
      // stock screen, where the same products show as low.
      to: planHasFeature(access.plan, 'PURCHASING') ? '/purchase/reorder' : '/inventory/stock',
    });
  }
  if (approvals) {
    items.push({
      kind: 'APPROVAL',
      severity: 'info',
      title: `${approvals} order(s) waiting for approval`,
      detail: 'Over a dealer’s credit limit — a manager decides.',
      count: approvals,
      to: '/sales/approvals',
    });
  }
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    items,
    total: items.reduce((t, i) => t + i.count, 0),
    generatedAt: new Date().toISOString(),
  };
}
