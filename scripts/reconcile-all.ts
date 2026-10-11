/**
 * Reconcile every org (Day 40): the stock caches against the stock ledger, and every party's
 * cached balance against its ledger entries. Read-only.
 *
 *   npx tsx scripts/reconcile-all.ts
 *
 * Point it elsewhere with the environment — the restore drill runs it against a restored copy:
 *
 *   MONGODB_URI=mongodb://localhost:27018/?directConnection=true MONGODB_DB_NAME=restore_drill \
 *     npx tsx scripts/reconcile-all.ts
 *
 * Exits 1 on any drift, so it can gate a deploy or a cron alert.
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { reconcileLedger } from '../src/modules/ledger/ledger.service.js';
import { Org } from '../src/modules/org/org.model.js';
import { reconcileStock } from '../src/modules/stock/reconcile.service.js';

await connectDatabase();
const orgs = await Org.find().select('name').lean();
let drift = 0;
for (const org of orgs) {
  const [stock, ledger] = await Promise.all([
    reconcileStock(org._id),
    reconcileLedger(org._id),
  ]);
  const ok = stock.clean && ledger.clean;
  if (!ok) drift += 1;
  console.log(
    `${ok ? 'clean' : 'DRIFT'}  ${org.name}  — stock ${stock.clean ? 'clean' : 'DRIFT'}, ` +
      `party balances ${ledger.clean ? 'clean' : `DRIFT (${ledger.drift.length} parties)`}`,
  );
  if (!stock.clean) console.log(JSON.stringify(stock, null, 2));
  if (!ledger.clean) console.log(JSON.stringify(ledger.drift, null, 2));
}
console.log(
  `\n${orgs.length} org(s) checked; ${drift ? `${drift} with drift` : 'zero drift'}.`,
);
await disconnectDatabase();
process.exit(drift ? 1 : 0);
