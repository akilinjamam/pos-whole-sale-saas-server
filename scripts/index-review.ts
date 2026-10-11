/**
 * Index review (Day 40) — run before go-live and after any change to a list screen:
 *
 *   npx tsx scripts/index-review.ts            # report
 *   npx tsx scripts/index-review.ts --sync     # also build missing indexes (never drops any)
 *
 * Two checks, both read-only unless `--sync`:
 *
 *  1. **Defined vs present.** Every index a schema declares must exist in the database. Mongoose's
 *     `autoIndex` builds them when a model first loads, but an index added after a collection was
 *     created can lag, and nothing ever reports one that failed to build (a unique index over
 *     duplicate data, say). Extra indexes in the database are listed, not dropped.
 *
 *  2. **The real query set.** Each list screen's actual filter and default sort, `explain()`ed.
 *     A `COLLSCAN` (reads the whole collection) or a blocking `SORT` (sorts in memory, and fails
 *     past 100 MB) on an org's own data is a finding. The org-wide queries are fine on an empty
 *     database too: the planner chooses by shape, not by size.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mongoose, { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const modules = join(here, '..', 'src', 'modules');
for (const dir of readdirSync(modules)) {
  for (const file of readdirSync(join(modules, dir))) {
    if (file.endsWith('.model.ts')) await import(join(modules, dir, file));
  }
}

await connectDatabase();
const sync = process.argv.includes('--sync');
const org = new Types.ObjectId();
const id = new Types.ObjectId();
const from = new Date(Date.now() - 30 * 86_400_000);

// ─── 1. Defined vs present ──────────────────────────────────────────────────────────────

const keyOf = (k: Record<string, unknown>) => JSON.stringify(k);
let missingTotal = 0;
console.log('\n── Indexes: defined vs present ──');
for (const model of Object.values(mongoose.models)) {
  const defined = model.schema.indexes().map(([fields]) => keyOf(fields));
  let present: string[] = [];
  try {
    present = (await model.collection.indexes()).map((i) =>
      keyOf(i.key as Record<string, unknown>),
    );
  } catch {
    present = []; // the collection does not exist yet
  }
  const missing = defined.filter((d) => !present.includes(d));
  const extra = present.filter((p) => p !== '{"_id":1}' && !defined.includes(p));
  missingTotal += missing.length;
  if (missing.length || extra.length) {
    console.log(`  ${model.modelName} (${model.collection.collectionName})`);
    missing.forEach((m) => console.log(`    MISSING ${m}`));
    extra.forEach((e) => console.log(`    extra   ${e}  (in the database, not in the schema)`));
  }
}
if (missingTotal === 0) console.log('  every defined index is present');
if (sync && missingTotal) {
  for (const model of Object.values(mongoose.models)) await model.createIndexes();
  console.log('  --sync: missing indexes built');
}

// ─── 2. The real query set ──────────────────────────────────────────────────────────────

type Q = {
  screen: string;
  model: string;
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
};
const Q = (
  screen: string,
  model: string,
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
): Q => ({
  screen,
  model,
  filter: { orgId: org, ...filter },
  sort,
});
const QUERIES: Q[] = [
  Q('Products', 'Product', { isActive: true }, { name: 1 }),
  Q('Variants of a product', 'Variant', { productId: id }, { variantKey: 1 }),
  Q('Dealers', 'Party', { roles: 'DEALER', isActive: true }, { name: 1 }),
  Q('Suppliers', 'Party', { roles: 'SUPPLIER' }, { name: 1 }),
  Q(
    'Stock on hand at a location',
    'StockBalance',
    { locationId: id },
    { productId: 1, variantId: 1, locationId: 1 },
  ),
  Q('Stock ledger', 'StockLedger', {}, { postedAt: -1, _id: -1 }),
  Q('Stock ledger of an item', 'StockLedger', { productId: id }, { postedAt: -1, _id: -1 }),
  Q(
    'Stock ledger of a document',
    'StockLedger',
    { refDocNo: 'GRN-2627-00001' },
    { postedAt: -1, _id: -1 },
  ),
  Q('Serial register', 'SerialUnit', { status: 'IN_STOCK' }, { lastMovementAt: -1 }),
  Q('Expiry report', 'Lot', {}, { expiryDate: 1, lotNo: 1 }),
  Q('Orders', 'WholesaleOrder', { isDeleted: false }, { orderDate: -1 }),
  Q(
    'Orders by status',
    'WholesaleOrder',
    { isDeleted: false, status: 'CONFIRMED' },
    { orderDate: -1 },
  ),
  Q(
    'A dealer’s orders',
    'WholesaleOrder',
    { isDeleted: false, dealerPartyId: id },
    { orderDate: -1 },
  ),
  Q('Challans', 'Dispatch', {}, { createdAt: -1 }),
  Q('Invoices', 'Invoice', {}, { invoiceDate: -1 }),
  Q('A dealer’s invoices', 'Invoice', { partyId: id }, { invoiceDate: -1 }),
  Q(
    'Open invoices (allocation)',
    'Invoice',
    { partyId: id, status: 'POSTED', balanceMinor: { $gt: 0 } },
    { invoiceDate: 1 },
  ),
  Q('Receipts', 'PaymentDoc', { direction: 'IN' }, { paidAt: -1 }),
  Q(
    'Cheque register',
    'PaymentDoc',
    { method: 'CHEQUE', 'instrument.status': 'PENDING' },
    { 'instrument.chequeDate': 1, paidAt: 1 },
  ),
  Q(
    'Supplier payments',
    'PaymentDoc',
    { direction: 'OUT', isRefund: { $ne: true }, posSessionId: null },
    { paidAt: -1 },
  ),
  Q('Party ledger / statement', 'LedgerEntry', { partyId: id }, { postedAt: 1, _id: 1 }),
  Q('Credit notes', 'CreditNote', {}, { postedAt: -1, _id: -1 }),
  Q('Sales returns', 'SalesReturn', { channel: 'WHOLESALE' }, { postedAt: -1, _id: -1 }),
  Q('Purchase orders', 'PurchaseOrder', { isDeleted: false }, { orderDate: -1, _id: -1 }),
  Q('Goods receipts', 'GoodsReceipt', {}, { receivedAt: -1, _id: -1 }),
  Q(
    'Supplier’s open bills',
    'GoodsReceipt',
    { supplierPartyId: id, status: 'POSTED', balanceMinor: { $gt: 0 } },
    { dueDate: 1 },
  ),
  Q('Purchase returns', 'PurchaseReturn', {}, { returnDate: -1, _id: -1 }),
  Q('Adjustments', 'StockAdjustment', {}, { createdAt: -1 }),
  Q('Transfers', 'StockTransfer', {}, { createdAt: -1 }),
  Q('Stock counts', 'StockCount', {}, { createdAt: -1 }),
  Q('Shifts', 'PosSession', {}, { openedAt: -1 }),
  Q('Audit log', 'AuditLog', {}, { at: -1, _id: -1 }),
  Q('Users', 'User', {}, { name: 1 }),
  // Reports and the dashboard, by date range.
  Q(
    'Sales report (invoices in a period)',
    'Invoice',
    { status: 'POSTED', invoiceDate: { $gte: from } },
    { invoiceDate: 1 },
  ),
  Q(
    'Dispatch register',
    'Dispatch',
    { status: { $in: ['DISPATCHED', 'DELIVERED'] }, dispatchedAt: { $gte: from } },
    { dispatchedAt: 1 },
  ),
  Q(
    'Collection register',
    'PaymentDoc',
    { series: 'RCPT', direction: 'IN', paidAt: { $gte: from } },
    { paidAt: 1 },
  ),
  Q(
    'Purchase register',
    'GoodsReceipt',
    { status: 'POSTED', postedAt: { $gte: from } },
    { postedAt: 1 },
  ),
];

/**
 * Screens over collections that stay small for an org — tens to a few thousand rows a year — where
 * sorting a page in memory costs nothing worth an extra index on every write. Reviewed on Day 40.
 */
const ACCEPTED = new Set([
  'Users',
  'Shifts',
  'Stock counts',
  'Transfers',
  'Adjustments',
  'Purchase orders',
  'Goods receipts',
  'Purchase returns',
  'Credit notes',
  'Cheque register',
  'Supplier payments',
  'Sales returns',
]);

type Stage = { stage: string; inputStage?: Stage; inputStages?: Stage[]; indexName?: string };
function stages(s: Stage | undefined, out: Stage[] = []): Stage[] {
  if (!s) return out;
  out.push(s);
  stages(s.inputStage, out);
  s.inputStages?.forEach((x) => stages(x, out));
  return out;
}

console.log('\n── The real query set ──');
const findings: string[] = [];
for (const q of QUERIES) {
  const model = mongoose.models[q.model];
  if (!model) {
    findings.push(`${q.screen}: no model ${q.model}`);
    continue;
  }
  const plan = (await model
    .find(q.filter)
    .sort(q.sort)
    .limit(25)
    .explain('queryPlanner')) as unknown as {
    queryPlanner: { winningPlan: Stage & { queryPlan?: Stage } };
  };
  const winning = plan.queryPlanner.winningPlan.queryPlan ?? plan.queryPlanner.winningPlan;
  const all = stages(winning);
  const index = all.find((s) => s.indexName)?.indexName ?? '—';
  const collscan = all.some((s) => s.stage === 'COLLSCAN');
  const sortStage = all.some((s) => s.stage === 'SORT');
  const raw = collscan ? 'COLLSCAN' : sortStage ? 'IN-MEMORY SORT' : 'ok';
  const verdict = raw !== 'ok' && ACCEPTED.has(q.screen) ? 'accepted' : raw;
  if (verdict !== 'ok' && verdict !== 'accepted')
    findings.push(`${q.screen} (${q.model}): ${verdict}`);
  console.log(`  ${verdict.padEnd(14)} ${q.screen.padEnd(38)} ${index}`);
}

console.log(
  `\n${findings.length ? `${findings.length} finding(s):\n  ${findings.join('\n  ')}` : 'No findings.'}`,
);
await disconnectDatabase();
process.exit(findings.length || missingTotal ? 1 : 0);
