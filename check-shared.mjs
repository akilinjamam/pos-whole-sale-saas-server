#!/usr/bin/env node
/**
 * Drift check for the duplicated API contract.
 *
 * `src/shared/` exists twice — once in the server, once in the client — so each project is
 * fully self-contained. The cost of that is that the two copies can silently diverge, and a
 * diverged contract is the worst kind of bug: the types still compile on both sides, so
 * nothing complains until a field is missing at runtime, in production, on a real invoice.
 *
 * This script is the guard. It compares every file byte for byte and exits non-zero on any
 * difference, so CI (and `npm run check:shared` before a commit) catches drift immediately.
 *
 * Run from pos-whole-sale-saas-server/:
 *   npm run check:shared            # report differences
 *   npm run check:shared -- --sync  # copy server -> client (server is the source of truth)
 */

import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, '..');

/** The server holds the canonical copy: it is where the contract is defined and enforced. */
const SOURCE = join(here, 'src', 'shared');
const TARGET = join(workspace, 'pos-whole-sale-saas-client', 'src', 'shared');

const SOURCE_LABEL = 'pos-whole-sale-saas-server/src/shared';
const TARGET_LABEL = 'pos-whole-sale-saas-client/src/shared';

const sync = process.argv.includes('--sync');

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Missing directory: ${dir}`);
      process.exit(2);
    }
    throw err;
  }
}

const [sourceFiles, targetFiles] = await Promise.all([listFiles(SOURCE), listFiles(TARGET)]);
const allNames = [...new Set([...sourceFiles, ...targetFiles])].sort();

const problems = [];
const fixes = [];

for (const name of allNames) {
  const inSource = sourceFiles.includes(name);
  const inTarget = targetFiles.includes(name);

  if (!inTarget) {
    problems.push(`  missing in client : ${name}`);
    fixes.push([join(SOURCE, name), join(TARGET, name)]);
    continue;
  }
  if (!inSource) {
    problems.push(`  extra in client   : ${name}  (not present in the server copy)`);
    continue;
  }

  const [a, b] = await Promise.all([
    readFile(join(SOURCE, name)),
    readFile(join(TARGET, name)),
  ]);
  if (!a.equals(b)) {
    problems.push(`  differs           : ${name}  (server ${hash(a)} vs client ${hash(b)})`);
    fixes.push([join(SOURCE, name), join(TARGET, name)]);
  }
}

if (problems.length === 0) {
  console.log(`shared contract in sync — ${allNames.length} files identical`);
  process.exit(0);
}

if (sync) {
  for (const [from, to] of fixes) await copyFile(from, to);
  console.log(`Synced ${fixes.length} file(s) from ${SOURCE_LABEL} -> ${TARGET_LABEL}`);
  const extras = problems.filter((p) => p.includes('extra in client'));
  if (extras.length > 0) {
    console.error('\nStill out of sync — these exist only in the client:');
    console.error(extras.join('\n'));
    console.error('\nDelete them, or add the matching file to the server copy.');
    process.exit(1);
  }
  process.exit(0);
}

console.error(`\nShared contract has drifted between:\n  ${SOURCE_LABEL}\n  ${TARGET_LABEL}\n`);
console.error(problems.join('\n'));
console.error('\nThe server copy is the source of truth.');
console.error('Run `npm run check:shared -- --sync` to copy server -> client, then re-typecheck both.\n');
process.exit(1);
