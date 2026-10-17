/**
 * Delete the data of closed businesses whose keeping period is over (SaaS phase 7). The work is in
 * `src/services/orgPurge.service.ts`.
 *
 *   npm run purge:orgs                          # dry run: who is due, and what would go
 *   npm run purge:orgs -- --org <orgId>         # dry run for one
 *   npm run purge:orgs -- --execute             # delete every business that is due
 *   npm run purge:orgs -- --org <orgId> --execute
 *
 * Only a business that is CANCELLED and past `purgeAfter` (closed + PURGE_AFTER_DAYS) is touched;
 * anything else is refused. There is no undo but a backup — take one first (docs/BACKUP.md), and
 * keep it for as long as the law or your terms say you must.
 */
import { parseArgs } from 'node:util';

import { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { purgeCandidates, purgeOrg } from '../src/services/orgPurge.service.js';

const { values } = parseArgs({
  options: { execute: { type: 'boolean', default: false }, org: { type: 'string' } },
});
if (values.org && !Types.ObjectId.isValid(values.org)) {
  console.error(`--org is not an id: ${values.org}`);
  process.exit(2);
}

await connectDatabase();
try {
  const ids = values.org
    ? [new Types.ObjectId(values.org)]
    : (await purgeCandidates()).map((o) => o._id);

  if (ids.length === 0) console.log('No closed business is past its keeping period.');
  for (const id of ids) {
    try {
      const r = await purgeOrg(id, { execute: values.execute });
      console.log(`\n${r.executed ? 'PURGED' : 'would purge'}  ${r.name}  (${r.orgId})`);
      for (const [name, n] of Object.entries(r.collections)) console.log(`  ${name.padEnd(28)} ${n}`);
      console.log(`  ${'counters'.padEnd(28)} ${r.counters}\n  ${'total'.padEnd(28)} ${r.total}`);
    } catch (err) {
      console.error(`\nrefused  ${String(id)}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  if (!values.execute && ids.length) console.log('\nDry run — nothing deleted. Add --execute to delete.');
} finally {
  await disconnectDatabase();
}
