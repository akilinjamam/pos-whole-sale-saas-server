import mongoose, { Types } from 'mongoose';
import { Zip, ZipDeflate } from 'fflate';

import { logger } from '../../config/logger.js';
import { ApiError } from '../../lib/ApiError.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { writeAudit } from '../../services/audit.service.js';

import { Org } from './org.model.js';

import type { RequestActor } from '../../lib/requestUser.js';
import type { Response } from 'express';

/**
 * `GET /org/export` — every record of the business, as a zip (SaaS phase 7).
 *
 *   README.txt              what the files are and how to read the numbers
 *   business.json           the company profile
 *   json/<collection>.json  every document, all fields (an array per collection)
 *   csv/<collection>.csv    the same, one row per document; nested fields as JSON text
 *
 * Their data belongs to them: it is open while read-only, suspended or closed (exempt from the
 * subscription check in `authenticate`), until it is purged. Streamed — read a page, zip it, write
 * it — so a large business never sits in memory whole.
 *
 * Collections are found, not listed: anything with this `orgId` goes in, so a module added later is
 * exported without anyone remembering to add it here. Left out: the platform's own collections,
 * one-time email tokens and the job's notice log; and on every document, secrets (password and
 * token hashes, token versions).
 */

/** Platform-level or internal: not the business's records. */
const SKIP = new Set([
  'orgs', // exported once, as business.json
  'counters',
  'email_tokens',
  'subscription_notices',
  'plans',
  'platform_admins',
  'platform_audit_logs',
]);

/** Never leaves the server, in any collection. */
const SECRET_FIELDS = ['passwordHash', 'tokenHash', 'tokenVersion'];

/** One export per business at a time — it is the heaviest read the API serves. */
const running = new Set<string>();

/** ObjectId → hex string, Date → ISO, recursively: plain JSON a spreadsheet person can read. */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const bsontype = (value as { _bsontype?: string })._bsontype;
    if (bsontype === 'ObjectId' || bsontype === 'ObjectID') return String(value);
    if (bsontype === 'Decimal128' || bsontype === 'Long') return String(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const README = `This zip holds every record of your business, exported from Optical Wholesale.

business.json            Your company profile.
json/<name>.json         Every record of one kind, with all its fields.
csv/<name>.csv           The same records as a spreadsheet: one row each. Fields that hold lists or
                         groups (order lines, an address) are written as JSON text in one cell.

How to read the numbers
- Every amount whose name ends in "Minor" is in poisha: divide by 100 for taka.
  (totalMinor 123456 = 1,234.56 taka)
- Dates and times are in UTC (ISO 8601). Bangladesh is UTC+6.
- "id", "_id" and every name ending in "Id" are record identifiers; they link records together
  (an invoice's partyId is the _id of a row in parties).

Passwords and sign-in secrets are not included.
`;

const enc = new TextEncoder();

export async function streamOrgExport(actor: RequestActor, res: Response): Promise<void> {
  const key = String(actor.orgId);
  if (running.has(key)) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'An export for your business is already running — wait for it to finish',
    );
  }
  const org = await Org.findById(actor.orgId).lean();
  if (!org) throw ApiError.notFound('Organisation');
  if (org.purgedAt) throw ApiError.notFound('Organisation');

  running.add(key);
  const db = mongoose.connection.db!;
  const counts: Record<string, number> = {};
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = org.slug ?? 'business';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-export-${stamp}.zip"`);
  res.setHeader('Cache-Control', 'no-store');

  // fflate hands compressed chunks to this callback; the response is the sink.
  let failed: Error | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failed = err;
      return;
    }
    res.write(Buffer.from(chunk));
    if (final) res.end();
  });

  /** Respect the socket: wait while the client is slower than the database. */
  const drain = async () => {
    if (res.writableNeedDrain) await new Promise((r) => res.once('drain', r));
  };

  const addFile = async (name: string, write: (push: (text: string) => Promise<void>) => Promise<void>) => {
    const file = new ZipDeflate(name, { level: 6 });
    zip.add(file);
    let buffer = '';
    const push = async (text: string) => {
      buffer += text;
      if (buffer.length >= 64 * 1024) {
        file.push(enc.encode(buffer));
        buffer = '';
        await drain();
      }
    };
    await write(push);
    file.push(enc.encode(buffer), true);
    await drain();
  };

  try {
    await addFile('README.txt', async (push) => push(README));
    const profile = plain(org) as Record<string, unknown>;
    await addFile('business.json', async (push) => push(JSON.stringify(profile, null, 2)));

    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.') && !SKIP.has(n))
      .sort();
    const projection = Object.fromEntries(SECRET_FIELDS.map((f) => [f, 0]));

    for (const name of names) {
      const collection = db.collection(name);
      const filter = { orgId: actor.orgId };
      if (!(await collection.findOne(filter, { projection: { _id: 1 } }))) continue;

      // JSON, and the column set for the CSV, in one pass.
      const columns = new Set<string>();
      let n = 0;
      await addFile(`json/${name}.json`, async (push) => {
        await push('[\n');
        for await (const doc of collection.find(filter, { projection }).sort({ _id: 1 })) {
          const row = plain(doc) as Record<string, unknown>;
          Object.keys(row).forEach((k) => columns.add(k));
          await push(`${n ? ',\n' : ''}${JSON.stringify(row)}`);
          n += 1;
        }
        await push('\n]\n');
      });
      counts[name] = n;

      const header = ['_id', ...[...columns].filter((c) => c !== '_id').sort()];
      await addFile(`csv/${name}.csv`, async (push) => {
        await push(`\uFEFF${header.map(csvCell).join(',')}\r\n`); // BOM: Excel reads it as UTF-8
        for await (const doc of collection.find(filter, { projection }).sort({ _id: 1 })) {
          const row = plain(doc) as Record<string, unknown>;
          await push(`${header.map((c) => csvCell(row[c])).join(',')}\r\n`);
        }
      });
    }
    zip.end();
    if (failed) throw failed;

    await withTransaction(async (session) => {
      await writeAudit(session, actor, {
        action: 'DATA_EXPORT',
        entity: 'Org',
        entityId: actor.orgId,
        after: counts,
      });
    });
    logger.info({ orgId: key, counts }, 'Business data exported');
  } catch (err) {
    // Headers are gone; all that is left is to cut the download short so it is not mistaken for a
    // whole file. The client sees a failed download.
    logger.error({ err, orgId: key }, 'Export failed');
    res.destroy(err as Error);
  } finally {
    running.delete(key);
  }
}
