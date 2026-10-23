#!/usr/bin/env node
/**
 * candiboost-pending.mjs — the Candiboost pending list and its ranking.
 *
 *   node candiboost-pending.mjs ingest <json>
 *   node candiboost-pending.mjs rank [--count N] [--summary]
 *   node candiboost-pending.mjs rematch
 *
 * `ingest` replaces data/candiboost-pending.tsv with the "En attente" rows the
 * agent read from the Candiboost page (`[{company, domain, status}]`). `rank` is
 * read-only: it lists the best tier 1 and 2 pending companies to personalise by
 * hand, and the rows that are not workable with the reason. `rematch` refills
 * `radar_key` only. No network, no model. The Candiboost page is untrusted data. See modes/candiboost.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { findBlacklistEntry, loadBlacklist } from './scan.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { CLI_EXIT, normalizeCompany } from './tracker-utils.mjs';
import { readRegistry, registryPath } from './radar/registry.mjs';
import { parseSpontaneous } from './radar/tiers.mjs';
import {
  PENDING_COLUMNS, RESOLVED_COLUMNS, buildProspectIndex, findTrackedRow, readTable, updateTable,
} from './lib/candiboost.mjs';
import { parseCandidates } from './radar/resolve.mjs';

const USAGE = `Usage: node candiboost-pending.mjs <ingest|rank|rematch> [options]

  ingest <json>
      Replace data/candiboost-pending.tsv with the "En attente" rows of <json>,
      an array of {company, domain, status} read from the Candiboost page.
  rank [--count N] [--summary]
      The best tier 1 and 2 pending companies to personalise (default 2, max
      10), each with the Candiboost row to delete after sending, then the rows
      that are not workable with the reason. Read-only.
  rematch
      Refill radar_key from the Radar, after the Radar gained the Candiboost
      spellings. Never renames a company and never clears a key.

Options:
  --count <n>   Picks to show for \`rank\` (1-10, default 2)
  --summary     Human-readable output instead of JSON
  --json        JSON output (the default)
  --help        This message
`;

const KNOWN_FLAGS = ['--count', '--summary', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--count'];
const SPEC = { key: 'company', columns: PENDING_COLUMNS };

function fail(message, code = CLI_EXIT.USAGE) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}

const collapse = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const fold = (text) => collapse(text).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** True for the Candiboost status "En attente", ignoring case and accents. */
export const isPendingStatus = (status) => fold(status) === 'en attente';

/** A page-read domain as `host.tld`, lower-case, or '' when it is not one. */
export function cleanDomain(value) {
  const host = collapse(value).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

/**
 * The distinct pending companies of a page read, whitespace collapsed, each
 * with its cleaned domain.
 * @returns {{company: string, domain: string}[]}
 * @throws {Error} when the input is not an array of `{company, status}` objects
 */
export function pendingCompanies(input) {
  if (!Array.isArray(input)) throw new Error('input is not a JSON array');
  const seen = new Set();
  const out = [];
  input.forEach((item, i) => {
    const company = collapse(item?.company);
    if (!company) throw new Error(`entry ${i + 1} has no company`);
    if (!isPendingStatus(item.status)) return;
    const key = normalizeCompany(company) || company.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ company, domain: cleanDomain(item.domain) });
  });
  return out;
}

function readTrackerRows(root) {
  const path = resolveTrackerPath(root);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

async function runIngest(args, root) {
  const [, file] = positionals(args);
  if (!file) fail('ingest takes a JSON file: ingest <json>');
  let companies;
  try {
    companies = pendingCompanies(JSON.parse(readFileSync(file, 'utf-8')));
  } catch (e) {
    fail(`${file}: ${e.message}`);
  }
  const index = buildProspectIndex(readRegistry(registryPath(root)).rows);
  const today = localToday();
  const receipt = await updateTable(join(root, 'data', 'candiboost-pending.tsv'), SPEC, (fresh) => {
    const firstSeen = new Map(fresh.rows.map((r) => [normalizeCompany(r.company) || r.company.toLowerCase(), r.first_seen]));
    let kept = 0;
    const rows = companies.map(({ company, domain }) => {
      const key = normalizeCompany(company) || company.toLowerCase();
      const prior = firstSeen.get(key);
      if (prior !== undefined) kept++;
      return {
        company,
        domain,
        radar_key: index.match(company, domain).row?.key ?? '',
        first_seen: prior || today,
        last_seen: today,
      };
    });
    const columns = [...fresh.columns, ...PENDING_COLUMNS.filter((c) => !fresh.columns.includes(c))];
    return { columns, rows, result: { new: rows.length - kept, kept, dropped: fresh.rows.length - kept, total: rows.length } };
  });
  console.log(JSON.stringify(receipt));
}

const NOT_IN_RADAR_YET = 'resolved, not in the Radar yet: run radar.mjs --source candiboost --write, then rematch';

function unmatchedReason(resolution) {
  if (!resolution) return 'no resolution yet';
  if (['resolved', 'hand', 'site'].includes(resolution.verdict)) return NOT_IN_RADAR_YET;
  if (resolution.verdict === 'ambiguous') return 'ambiguous: fill entity_id in data/candiboost-resolved.tsv';
  if (resolution.verdict === 'out-of-zone') {
    const places = [...new Set(parseCandidates(resolution.candidates).map((c) => c.place).filter(Boolean))].slice(0, 3);
    return places.length ? `out-of-zone: ${places.join(', ')}` : 'out-of-zone';
  }
  if (resolution.verdict === 'unresolved') return 'unresolved';
  return 'no resolution yet';
}

/**
 * Rank pending rows: untracked, not blacklisted, not marked for Spontaneous, and
 * in tier 1 or 2 (1 before 2, ties by name). Every other such row goes to
 * `notWorkable` with its reason.
 */
export function rankPending(rows, { radarByKey, trackerRows, isBlacklisted, resolutionFor = () => null, matchFor = () => null, count = 2 }) {
  const excluded = { tracked: 0, blacklisted: 0, marked: 0, out: 0 };
  const eligible = [];
  const notWorkable = [];
  for (const row of rows) {
    const radar = radarByKey.get(row.radar_key) ?? null;
    const names = [row.company, radar?.name,
      ...String(radar?.aliases ?? '').split(';').map((a) => a.trim()).filter((a) => a && !a.startsWith('#'))];
    if (findTrackedRow(names, trackerRows)) { excluded.tracked++; continue; }
    if (names.filter(Boolean).some(isBlacklisted)) { excluded.blacklisted++; continue; }
    if (radar && parseSpontaneous(radar.spontaneous).state !== 'none') { excluded.marked++; continue; }
    if (!radar) {
      const match = matchFor(row);
      const resolution = resolutionFor(row.company);
      const reason = match?.ambiguous && ['resolved', 'hand', 'site'].includes(resolution?.verdict)
        ? `Radar match ambiguous (${match.hits} rows): fill radar_key in data/candiboost-pending.tsv`
        : unmatchedReason(resolution);
      notWorkable.push({ company: row.company, reason });
      continue;
    }
    if (radar.tier === '1' || radar.tier === '2') { eligible.push({ row, tier: radar.tier }); continue; }
    if (radar.tier === 'out') { excluded.out++; notWorkable.push({ company: row.company, reason: radar.tier_reason || 'tier out' }); continue; }
    if (radar.tier === '3') { notWorkable.push({ company: row.company, reason: radar.tier_reason || 'tier 3' }); continue; }
    notWorkable.push({ company: row.company, reason: 'no tier yet: run node radar-tiers.mjs --write' });
  }
  eligible.sort((a, b) => Number(a.tier) - Number(b.tier) || a.row.company.localeCompare(b.row.company));
  notWorkable.sort((a, b) => a.company.localeCompare(b.company));
  const picks = eligible.slice(0, count).map(({ row, tier }, i) => ({
    rank: i + 1,
    company: row.company,
    radar_key: row.radar_key,
    tier,
    deleteRow: row.company,
  }));
  return { picks, excluded, eligible: eligible.length, notWorkable, total: rows.length };
}

function renderRank(out) {
  const ex = out.excluded;
  const lines = [`Candiboost pending — ${out.eligible} eligible of ${out.total}; excluded: ${ex.tracked} tracked, ${ex.blacklisted} blacklisted, ${ex.marked} marked, ${ex.out} tier out`];
  for (const p of out.picks) {
    lines.push(`  ${p.rank}. ${p.company} — tier ${p.tier} (${p.radar_key})`);
    lines.push(`     after you send it, delete the row "${p.deleteRow}" in Candiboost`);
  }
  if (out.picks.length === 0) lines.push('  nothing eligible');
  lines.push(`not workable: ${out.notWorkable.length}`);
  for (const n of out.notWorkable) lines.push(`  - ${n.company}: ${n.reason}`);
  return lines.join('\n');
}

function runRank(args, root) {
  const rawCount = flagValue(args, '--count');
  let count = 2;
  if (rawCount !== undefined) {
    count = Number.parseInt(rawCount, 10);
    if (!Number.isInteger(count) || count < 1) fail(`--count takes a number from 1 to 10, got "${rawCount}"`);
    count = Math.min(count, 10);
  }
  const pending = readTable(join(root, 'data', 'candiboost-pending.tsv'), SPEC);
  if (pending.missing) fail('no pending list: run candiboost-pending.mjs ingest <json> first');
  const registryRows = readRegistry(registryPath(root)).rows;
  const radarByKey = new Map(registryRows.map((r) => [r.key, r]));
  const index = buildProspectIndex(registryRows);
  const blacklist = loadBlacklist(join(root, 'data', 'blacklist.md'));
  const resolved = readTable(join(root, 'data', 'candiboost-resolved.tsv'), { key: 'company', columns: RESOLVED_COLUMNS });
  const resolutions = new Map(resolved.rows.map((r) => [r.company, r]));
  const out = rankPending(pending.rows, {
    radarByKey,
    trackerRows: readTrackerRows(root),
    isBlacklisted: (name) => findBlacklistEntry(blacklist, name, '') !== null,
    resolutionFor: (company) => resolutions.get(company) ?? null,
    matchFor: (row) => index.match(row.company, row.domain ?? ''),
    count,
  });
  console.log(args.includes('--summary') ? renderRank(out) : JSON.stringify(out, null, 2));
}

async function runRematch(root) {
  const path = join(root, 'data', 'candiboost-pending.tsv');
  if (readTable(path, SPEC).missing) fail('no pending list: run candiboost-pending.mjs ingest <json> first');
  const index = buildProspectIndex(readRegistry(registryPath(root)).rows);
  const receipt = await updateTable(path, SPEC, (fresh) => {
    let matched = 0;
    let unmatched = 0;
    let changed = 0;
    const rows = fresh.rows.map((row) => {
      const hit = index.match(row.company, row.domain ?? '').row;
      if (!hit) { unmatched++; return row; }
      matched++;
      if (hit.key === row.radar_key) return row;
      changed++;
      return { ...row, radar_key: hit.key };
    });
    return { rows, result: { matched, unmatched, changed } };
  });
  console.log(JSON.stringify(receipt));
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const root = getCareerOpsRoot();
  const [command] = positionals(args);
  if (command === 'ingest') await runIngest(args, root);
  else if (command === 'rank') runRank(args, root);
  else if (command === 'rematch') await runRematch(root);
  else fail('first argument must be ingest, rank or rematch (see --help)');
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}
