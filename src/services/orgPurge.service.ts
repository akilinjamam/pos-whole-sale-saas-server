import mongoose from 'mongoose';

import { logger } from '../config/logger.js';
import { ApiError } from '../lib/ApiError.js';
import { Org } from '../modules/org/org.model.js';

import { invalidateOrgAccess } from './subscription.service.js';

import type { Types } from 'mongoose';

/**
 * Deleting a closed business's data — SaaS phase 7. Used by `scripts/purge-org.ts`, never by a route.
 *
 * Every collection is searched for the business's `orgId` (found, not listed, so a module added
 * later is covered), plus its document-number counters (keyed `<orgId>:…`). Kept:
 *   - the platform's own records about the business — its subscription payments (receipts the
 *     platform issued) and the platform audit log;
 *   - the org document itself, as a tombstone: name, slug, status and dates stay so payments and
 *     history still say whose they were; contact details are cleared and `purgedAt` set.
 *
 * Not a transaction: a purge can be millions of documents. It is idempotent instead — a purge cut
 * short is finished by running it again.
 */

/** Platform records that outlive the business, and the two handled separately. */
const KEEP = new Set([
  'orgs',
  'counters',
  'plans',
  'platform_admins',
  'platform_audit_logs',
  'subscription_payments',
]);

export interface PurgeReport {
  orgId: string;
  name: string;
  /** Documents per collection — found (dry run) or deleted. */
  collections: Record<string, number>;
  counters: number;
  total: number;
  executed: boolean;
}

/** Closed businesses whose keeping period is over and that are not yet purged. */
export async function purgeCandidates(now = new Date()) {
  return Org.find({ status: 'CANCELLED', purgeAfter: { $lte: now }, purgedAt: null })
    .select('name slug cancelledAt purgeAfter cancelledBy')
    .lean();
}

/**
 * Purge one business. Refuses unless it is CANCELLED and past `purgeAfter` — the script cannot be
 * pointed at a live business by a mistyped id.
 */
export async function purgeOrg(
  orgId: Types.ObjectId,
  options: { execute: boolean; now?: Date },
): Promise<PurgeReport> {
  const now = options.now ?? new Date();
  const org = await Org.findById(orgId).select('name status purgeAfter purgedAt').lean();
  if (!org) throw ApiError.notFound('Business');
  if (org.status !== 'CANCELLED' || !org.purgeAfter || org.purgeAfter > now) {
    throw ApiError.conflict(
      'ILLEGAL_TRANSITION',
      `${org.name} is not closed past its keeping period (status ${org.status}, purge after ${org.purgeAfter?.toISOString() ?? 'never'})`,
    );
  }

  const db = mongoose.connection.db!;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.') && !KEEP.has(n))
    .sort();

  const collections: Record<string, number> = {};
  for (const name of names) {
    const filter = { orgId };
    const n = options.execute
      ? (await db.collection(name).deleteMany(filter)).deletedCount
      : await db.collection(name).countDocuments(filter);
    if (n) collections[name] = n;
  }
  const counterFilter = { _id: { $regex: `^${String(orgId)}:` } } as never;
  const counters = options.execute
    ? (await db.collection('counters').deleteMany(counterFilter)).deletedCount
    : await db.collection('counters').countDocuments(counterFilter);

  if (options.execute) {
    await Org.updateOne(
      { _id: orgId },
      {
        $set: {
          purgedAt: now,
          legalName: null,
          bin: null,
          vatRegNo: null,
          tin: null,
          phone: null,
          email: null,
          address: null,
          logoUrl: null,
          invoiceHeaderNote: null,
          invoiceFooter: null,
          planRequest: null,
        },
      },
    );
    invalidateOrgAccess(orgId);
  }

  const report: PurgeReport = {
    orgId: String(orgId),
    name: org.name,
    collections,
    counters,
    total: Object.values(collections).reduce((a, b) => a + b, 0) + counters,
    executed: options.execute,
  };
  logger.info(report, options.execute ? 'Business purged' : 'Business purge (dry run)');
  return report;
}
