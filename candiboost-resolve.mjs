#!/usr/bin/env node
/**
 * candiboost-resolve.mjs — re-run the Candiboost resolution without a new fold.
 *
 *   node candiboost-resolve.mjs resettle [--dry-run]
 *   node candiboost-resolve.mjs retry [--dry-run]
 *
 * `resettle` settles `ambiguous` rows of data/candiboost-resolved.tsv offline by
 * the brand rule, from the candidates already stored. `retry` backs the file up
 * to data/backup-{date}-retry/ and deletes the `unresolved` rows, so the next
 * `radar.mjs --source candiboost` run looks them up again (name variants, then
 * the company's own website). Rows carrying a hand edit are never touched.
 * No network, no model. See modes/candiboost.md.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { CLI_EXIT } from './tracker-utils.mjs';
import { CandiboostTableError, RESOLVED_COLUMNS, readTable, updateTable } from './lib/candiboost.mjs';
import { chooseEntity, needleFor, parseCandidates, rowFor } from './radar/resolve.mjs';
import { RadarConfigError, loadZoneTable } from './radar/zones.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node candiboost-resolve.mjs <resettle|retry> [options]

  resettle [--dry-run]
      Settle the ambiguous rows of data/candiboost-resolved.tsv by the brand
      rule, offline, from the stored candidates. Prints each pick. Rows that do
      not settle stay byte-identical.
  retry [--dry-run]
      Back the file up to data/backup-{date}-retry/, then delete the unresolved
      rows so the next candiboost fold looks them up again.

Rows with a filled entity_id or place are hand edits waiting for promotion and
are never touched.

Options:
  --dry-run   Print what would change and write nothing
  --json      JSON output (the default)
  --help      This message
`;

const KNOWN_FLAGS = ['--dry-run', '--json', '--help', '-h'];
const SPEC = { key: 'company', columns: RESOLVED_COLUMNS };
const text = (value) => String(value ?? '').trim();

function fail(message, code = CLI_EXIT.USAGE) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function positionals(args) {
  return args.filter((a) => !a.startsWith('-'));
}

const handEdited = (row) => text(row.entity_id) !== '' || text(row.place) !== '';

/**
 * Settle the `ambiguous` rows the brand rule now resolves, from their stored
 * candidates. Every other row is returned as the same object.
 *
 * @returns {{rows: object[], picks: {company:string, legalName:string, place:string, capped:boolean}[],
 *   stillAmbiguous: number, handEdits: number, skipped: string[]}}
 */
export function resettleRows(rows, { table, today }) {
  const picks = [];
  const skipped = [];
  let stillAmbiguous = 0;
  let handEdits = 0;
  const out = rows.map((row) => {
    if (row.verdict !== 'ambiguous') return row;
    if (handEdited(row)) { handEdits++; return row; }
    const needle = needleFor(row.company);
    const listed = parseCandidates(row.candidates);
    if (!needle || listed.length === 0) { skipped.push(row.company); return row; }
    const candidates = listed.map((c) => ({
      needle: needle.server,
      legalName: c.legalName,
      entityId: c.entityId,
      place: c.place,
      postcode: c.postcode,
      country: c.entityId.startsWith('siren:') ? 'FR' : 'CH',
    }));
    const picked = chooseEntity(needle, candidates, { table });
    if (picked.verdict !== 'resolved') { stillAmbiguous++; return row; }
    picks.push({
      company: row.company,
      legalName: picked.entity.legalName,
      place: picked.site.place,
      capped: /\+\d+ more$/.test(row.candidates),
    });
    return { ...row, ...rowFor({ spelling: row.company, domain: row.domain }, 'resolved', picked, today), candidates: row.candidates };
  });
  return { rows: out, picks, stillAmbiguous, handEdits, skipped };
}

/** Delete the `unresolved` rows without a hand edit. */
export function retryRows(rows) {
  let deleted = 0;
  let keptHandEdits = 0;
  const kept = rows.filter((row) => {
    if (row.verdict !== 'unresolved') return true;
    if (handEdited(row)) { keptHandEdits++; return true; }
    deleted++;
    return false;
  });
  return { rows: kept, deleted, keptHandEdits };
}

function readResolved(root) {
  const path = join(root, 'data', 'candiboost-resolved.tsv');
  const read = readTable(path, SPEC);
  if (read.missing) fail('no resolution table: run radar.mjs --source candiboost first');
  return { path, read };
}

function printResettle(r, written) {
  console.log(JSON.stringify({
    resettled: r.picks.length, stillAmbiguous: r.stillAmbiguous, handEdits: r.handEdits, skipped: r.skipped.length, written,
  }));
  for (const p of r.picks) console.log(`  ${p.company} → ${p.legalName} @ ${p.place}${p.capped ? ' (from the first 20 listed)' : ''}`);
  for (const company of r.skipped) console.log(`  skipped: ${company} (candidates do not parse)`);
}

async function runResettle(args, root) {
  const { path, read } = readResolved(root);
  const ctx = { table: loadZoneTable({ dataRoot: root, codeRoot: CODE_ROOT }), today: localToday() };
  const planned = resettleRows(read.rows, ctx);
  if (planned.picks.length === 0 || args.includes('--dry-run')) {
    printResettle(planned, false);
    return;
  }
  const result = await updateTable(path, SPEC, (fresh) => {
    const r = resettleRows(fresh.rows, ctx);
    return { rows: r.rows, result: r };
  });
  printResettle(result, true);
}

async function runRetry(args, root) {
  const { path, read } = readResolved(root);
  const planned = retryRows(read.rows);
  const dryRun = args.includes('--dry-run');
  if (planned.deleted === 0 || dryRun) {
    console.log(JSON.stringify({ deleted: planned.deleted, keptHandEdits: planned.keptHandEdits, backup: null, ...(dryRun ? { dryRun: true } : {}) }));
    return;
  }
  const relative = `data/backup-${localToday()}-retry/candiboost-resolved.tsv`;
  const backupPath = join(root, relative);
  if (existsSync(backupPath)) fail(`backup exists: ${relative}, move it away first`);
  mkdirSync(dirname(backupPath), { recursive: true });
  const result = await updateTable(path, SPEC, (fresh) => {
    copyFileSync(path, backupPath);
    const r = retryRows(fresh.rows);
    return { rows: r.rows, result: r };
  });
  console.log(JSON.stringify({ deleted: result.deleted, keptHandEdits: result.keptHandEdits, backup: relative }));
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { requireOperand: true });
  const root = getCareerOpsRoot();
  const [command] = positionals(args);
  try {
    if (command === 'resettle') await runResettle(args, root);
    else if (command === 'retry') await runRetry(args, root);
    else fail('first argument must be resettle or retry (see --help)');
  } catch (e) {
    if (e instanceof CandiboostTableError || e instanceof RadarConfigError) fail(e.message);
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}
