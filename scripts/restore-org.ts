/**
 * Restore ONE business from a backup into a SCRATCH database (SaaS phase 7) — for "we deleted the
 * wrong dealer last Tuesday" without rolling every other business back with it.
 *
 *   npx tsx scripts/restore-org.ts --archive <file.archive.gz> --org <orgId>
 *
 * Options (and environment):
 *   --uri        RESTORE_URI   where to restore — a scratch server, default the local replica set
 *                              mongodb://localhost:27019/?directConnection=true
 *   --source-db  SOURCE_DB     the database inside the archive, default pos_wholesale_saas
 *   --db                       the scratch database, default restore_org_<orgId> (dropped first)
 *   MONGORESTORE               default "mongorestore"; e.g. "docker exec -i pos-wholesale-saas-mongo mongorestore"
 *
 * What it does: restores the whole archive into the scratch database, then deletes every other
 * business's documents (and the platform admins, whose password hashes have no business there),
 * leaving that one business as it was when the backup was taken. Nothing is written to the live
 * database. From there, look at it with mongosh, reconcile it, or copy single documents back — see
 * docs/BACKUP.md, "Restoring one business".
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import mongoose, { Types } from 'mongoose';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    org: { type: 'string' },
    uri: { type: 'string' },
    'source-db': { type: 'string' },
    db: { type: 'string' },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const archive =
  values.archive ?? fail('Usage: restore-org.ts --archive <file.archive.gz> --org <orgId>');
if (!values.org || !Types.ObjectId.isValid(values.org)) fail(`--org must be a business id`);
const orgId = new Types.ObjectId(values.org);
const uri =
  values.uri ?? process.env.RESTORE_URI ?? 'mongodb://localhost:27019/?directConnection=true';
const sourceDb = values['source-db'] ?? process.env.SOURCE_DB ?? 'pos_wholesale_saas';
const target = values.db ?? `restore_org_${String(orgId)}`;
const mongorestore = (process.env.MONGORESTORE ?? 'mongorestore').split(' ').filter(Boolean);

if (target === sourceDb || target === process.env.MONGODB_DB_NAME) {
  fail(`Refusing: the scratch database "${target}" is the live database's name.`);
}
await access(archive).catch(() => fail(`No such archive: ${archive}`));

/** Platform collections: kept, emptied, or filtered by the business they name. */
const DROP = ['platform_admins'];
const BY_TARGET_ORG: Record<string, string> = { platform_audit_logs: 'targetOrgId' };
const KEEP_WHOLE = ['plans'];

const conn = await mongoose.createConnection(uri).asPromise();
try {
  const db = conn.useDb(target, { useCache: false }).db!;

  console.log(`dropping scratch database ${target}`);
  await db.dropDatabase();

  console.log(`restoring ${archive} (${sourceDb}.*) into ${target}`);
  await new Promise<void>((resolve, reject) => {
    const [cmd, ...pre] = mongorestore;
    const child = spawn(
      cmd!,
      [
        ...pre,
        `--uri=${uri}`,
        '--archive',
        '--gzip',
        `--nsFrom=${sourceDb}.*`,
        `--nsTo=${target}.*`,
        '--quiet',
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    createReadStream(archive).pipe(child.stdin);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`mongorestore exited with ${code}`)),
    );
  });

  const org = await db.collection('orgs').findOne({ _id: orgId });
  if (!org) {
    throw new Error(`Business ${String(orgId)} is not in this backup — wrong archive or id?`);
  }
  console.log(`found ${String(org.name)} — removing every other business`);

  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'));
  for (const name of names) {
    const collection = db.collection(name);
    if (DROP.includes(name)) await collection.drop();
    else if (name === 'orgs') await collection.deleteMany({ _id: { $ne: orgId } });
    else if (name === 'counters')
      await collection.deleteMany({ _id: { $not: new RegExp(`^${String(orgId)}:`) } } as never);
    else if (BY_TARGET_ORG[name])
      await collection.deleteMany({ [BY_TARGET_ORG[name]]: { $ne: orgId } });
    else if (!KEEP_WHOLE.includes(name))
      // `$exists` too: a document with no orgId is not this business's either.
      await collection.deleteMany({ $or: [{ orgId: { $exists: false } }, { orgId: { $ne: orgId } }] });
  }

  console.log(`\n${String(org.name)} as it was in the backup, in ${target}:`);
  for (const name of (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .sort()) {
    const n = await db.collection(name).countDocuments();
    if (n) console.log(`  ${name.padEnd(28)} ${n}`);
  }
  console.log(
    `\nCheck it balances:\n  MONGODB_URI='${uri}' MONGODB_DB_NAME=${target} npx tsx scripts/reconcile-all.ts` +
      `\nDrop it when done:\n  mongosh '${uri}' --eval "db.getSiblingDB('${target}').dropDatabase()"`,
  );
} catch (err) {
  console.error(`\n${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await conn.close();
}
