#!/usr/bin/env node
/**
 * spontaneous-pick.mjs — pick today's Spontaneous application and record its state.
 *
 *   node spontaneous-pick.mjs next [--count N] [--summary]
 *   node spontaneous-pick.mjs mark <key> drafted|skipped|sent [--tracker N] [--reason "..."]
 *
 * `next` is read-only: it lists the best untouched tier 1 (then tier 2) Prospects
 * of data/radar.tsv, never one that is marked, already in the tracker or
 * blacklisted. `mark` changes only the `spontaneous` cell of one row, under the
 * registry lock. No network, no model. See modes/spontaneous.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { findBlacklistEntry, loadBlacklist } from './scan.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { CLI_EXIT, normalizeCompany } from './tracker-utils.mjs';
import { parseContacts } from './contacts.mjs';
import { findContactsByCompany } from './contact-lookup.mjs';
import { baseKey } from './radar/identity.mjs';
import { PENDING_COLUMNS, readTable } from './lib/candiboost.mjs';
import { RADAR_COLUMNS, readRegistry, registryPath, updateRegistry } from './radar/registry.mjs';
import { RadarConfigError } from './radar/zones.mjs';
import {
  classify, compareProspects, formatSpontaneous, loadTierRules, parseSpontaneous, prospectNames,
} from './radar/tiers.mjs';
import { registerOnly } from './radar/enrich.mjs';
import { parseHints, webDomain } from './radar/hints.mjs';

/** How many of the next Prospects count when looking for ones that no Site probe has read. */
const PROBE_WINDOW = 30;
const PROBE_WARN_ABOVE = 15;

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node spontaneous-pick.mjs <next|mark> [options]

  next [--count N] [--summary]
      List the best untouched tier 1 (then tier 2) Prospects, default 3, max 10.
      Excludes marked, tracked and blacklisted Prospects. Read-only.
  mark <key> <drafted|skipped|sent> [--tracker N] [--reason "..."]
      Record where a Spontaneous application stands. \`sent\` needs --tracker N,
      the tracker row of the application, whose Company must match the Prospect.

Options:
  --count <n>        Picks to show for \`next\` (1-10, default 3)
  --tracker <n>      Tracker row number for \`mark ... sent\`
  --reason <text>    Why a Prospect was skipped
  --summary          Human-readable output instead of JSON
  --json             JSON output (the default)
  --help             This message
`;

const KNOWN_FLAGS = ['--count', '--tracker', '--reason', '--summary', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--count', '--tracker', '--reason'];

export class MarkError extends Error {
  constructor(message, exit) {
    super(message);
    this.name = 'MarkError';
    this.exit = exit;
  }
}

function fail(message, code = CLI_EXIT.USAGE) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

/** The `key` column with any `|country|site` collision suffix removed. */
const keyBase = (row) => String(row['key'] ?? '').split('|')[0];

/**
 * Build the "already in the tracker" test from the tracker's Company cells. A
 * Prospect matches when any of its names, or its key, equals a tracker company
 * under the shared normalizer or after the radar's legal-form stripping.
 */
export function makeTrackedCheck(companies) {
  const normalized = new Set(companies.map((c) => normalizeCompany(c)).filter(Boolean));
  const bases = new Set(companies.map((c) => baseKey(c)).filter(Boolean));
  return (row) => {
    if (bases.has(baseKey(keyBase(row)))) return true;
    return prospectNames(row).some((n) => normalized.has(normalizeCompany(n)) || bases.has(baseKey(n)));
  };
}

/** True when the tracker Company cell names this Prospect. */
export function trackerCompanyMatches(row, company) {
  return makeTrackedCheck([company])(row);
}

/**
 * @returns {{picks: object[], excluded: {marked: number, tracked: number, blacklisted: number},
 *            eligible: number, untiered: number, staleTiers: number, unprobed: number, probeWindow: number}}
 *   `unprobed` counts the register-only Prospects among the first `probeWindow` eligible ones that no Site probe has read.
 */
export function pickNext(rows, rules, { isTracked, isBlacklisted, contactsFor, candiboostRowFor = () => null, count = 3 }) {
  const excluded = { marked: 0, tracked: 0, blacklisted: 0 };
  let untiered = 0;
  let staleTiers = 0;
  const eligible = [];
  for (const row of rows) {
    if (!row.tier) untiered++;
    else if (classify(row, rules, { isBlacklisted }).tier !== row.tier) staleTiers++;
    if (row.tier !== '1' && row.tier !== '2') continue;
    if (parseSpontaneous(row.spontaneous).state !== 'none') { excluded.marked++; continue; }
    if (isTracked(row)) { excluded.tracked++; continue; }
    if (isBlacklisted(row)) { excluded.blacklisted++; continue; }
    eligible.push(row);
  }
  eligible.sort((a, b) => (a.tier === b.tier ? compareProspects(a, b, rules) : a.tier < b.tier ? -1 : 1));
  const picks = eligible.slice(0, count).map((row, i) => ({
    rank: i + 1,
    key: row['key'],
    name: row.name,
    tier: row.tier,
    tier_reason: row.tier_reason,
    sites: String(row.sites ?? '').split(';').filter(Boolean),
    country: row.country,
    signals: Number.parseInt(row.signals, 10) || 0,
    size_band: row.size_band || '?',
    sources: String(row.sources ?? '').split(';').map((s) => s.trim()).filter((t) => t && !t.includes(':')),
    portals_ref: row.portals_ref && row.portals_ref !== '—' ? row.portals_ref : null,
    web: webDomain(row.hints),
    hints: parseHints(row.hints),
    savedContacts: contactsFor(row),
    candiboostPending: candiboostRowFor(row) !== null,
    candiboostRow: candiboostRowFor(row),
  }));
  const window = eligible.slice(0, PROBE_WINDOW);
  const unprobed = window.filter((row) => registerOnly(row) && !parseHints(row.hints).some((t) => t.startsWith('checked:'))).length;
  return { picks, excluded, eligible: eligible.length, untiered, staleTiers, unprobed, probeWindow: window.length };
}

const TRANSITIONS = {
  none: ['drafted', 'skipped', 'sent'],
  drafted: ['drafted', 'skipped', 'sent'],
  skipped: ['drafted', 'skipped'],
  sent: [],
};

/**
 * The new `spontaneous` cell for a row, or a MarkError when the transition is refused.
 * `sent` needs `mark.tracker`, checked against the tracker by the caller.
 */
export function applyMark(row, mark, { today }) {
  const from = parseSpontaneous(row.spontaneous);
  const current = from.state === 'invalid' ? 'none' : from.state;
  if (!TRANSITIONS[current].includes(mark.state)) {
    throw new MarkError(`"${row['key']}" is ${current}: it cannot become ${mark.state}`, CLI_EXIT.AMBIGUOUS);
  }
  if (mark.state === 'sent') return formatSpontaneous({ state: 'sent', date: today, tracker: mark.tracker });
  if (mark.state === 'skipped') return formatSpontaneous({ state: 'skipped', date: today, why: mark.reason });
  return formatSpontaneous({ state: 'drafted', date: today });
}

function readTrackerRows(root) {
  const path = resolveTrackerPath(root);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}

function renderNext(out) {
  const lines = [`Spontaneous — ${out.eligible} eligible; excluded: ${out.excluded.marked} marked, ${out.excluded.tracked} tracked, ${out.excluded.blacklisted} blacklisted`];
  for (const p of out.picks) {
    const board = p.portals_ref ? ` · board: ${p.portals_ref}` : '';
    const contacts = p.savedContacts ? ` · ${p.savedContacts} saved contact(s)` : '';
    const web = p.web ? ` · web: ${p.web}` : p.hints.includes('site:none') ? ' · no site found' : '';
    lines.push(`  ${p.rank}. ${p.name} (${p.key}) — tier ${p.tier} · ${p.sites.join(', ')} · ${p.country} · ${p.signals} signal(s) · size ${p.size_band}${board}${web}${contacts}${p.sources.length ? ` · sources: ${p.sources.join(', ')}` : ''}`);
    lines.push(`     ${p.tier_reason}`);
    if (p.candiboostPending) lines.push(`     pending in Candiboost: delete row "${p.candiboostRow}" after sending`);
  }
  if (out.picks.length === 0) lines.push('  nothing eligible: run node radar-tiers.mjs --write, or loosen config/radar-tiers.yml');
  if (out.unprobed > PROBE_WARN_ABOVE) {
    lines.push(`  ${out.unprobed} of the next ${out.probeWindow} Prospects have no Site probe: run node radar-enrich.mjs --sites --limit 40 --summary`);
  }
  if (out.untiered || out.staleTiers) {
    lines.push(`  ${out.untiered} untiered, ${out.staleTiers} stale: run node radar-tiers.mjs --write --summary`);
  }
  return lines.join('\n');
}

function loadRules(root) {
  try {
    return loadTierRules({ dataRoot: root, codeRoot: CODE_ROOT });
  } catch (e) {
    if (e instanceof RadarConfigError) fail(e.message);
    throw e;
  }
}

function runNext(args, root) {
  const rawCount = flagValue(args, '--count');
  let count = 3;
  if (rawCount !== undefined) {
    count = Number.parseInt(rawCount, 10);
    if (!Number.isInteger(count) || count < 1) fail(`--count takes a number from 1 to 10, got "${rawCount}"`);
    count = Math.min(count, 10);
  }
  const rules = loadRules(root);
  const registry = readRegistry(registryPath(root));
  if (registry.missing) fail(`no registry: run radar.mjs --write first`);

  const blacklist = loadBlacklist(join(root, 'data', 'blacklist.md'));
  const isBlacklisted = (row) => prospectNames(row).some((n) => findBlacklistEntry(blacklist, n, '') !== null);
  const isTracked = makeTrackedCheck(readTrackerRows(root).map((t) => t.company));
  const contactsPath = join(root, 'data', 'contacts.tsv');
  const contacts = existsSync(contactsPath) ? parseContacts(readFileSync(contactsPath, 'utf-8')).contacts : [];
  const contactsFor = (row) => prospectNames(row).reduce((n, name) => n + findContactsByCompany(contacts, name).length, 0);

  const pending = readTable(join(root, 'data', 'candiboost-pending.tsv'), { key: 'company', columns: PENDING_COLUMNS }).rows;
  const pendingByKey = new Map(pending.filter((p) => p.radar_key).map((p) => [p.radar_key, p.company]));
  const pendingByBase = new Map(pending.map((p) => [baseKey(p.company), p.company]).filter(([b]) => b));
  const candiboostRowFor = (row) => pendingByKey.get(row['key'])
    ?? pendingByBase.get(baseKey(row.name))
    ?? null;

  const out = pickNext(registry.rows, rules, { isTracked, isBlacklisted, contactsFor, candiboostRowFor, count });
  console.log(args.includes('--summary') ? renderNext(out) : JSON.stringify(out, null, 2));
}

async function runMark(args, root) {
  const [, key, state] = positionals(args);
  if (!key || !state) fail('mark takes a key and a state: mark <key> drafted|skipped|sent');
  if (!['drafted', 'skipped', 'sent'].includes(state)) fail(`unknown state "${state}": use drafted, skipped or sent`);

  const mark = { state, reason: flagValue(args, '--reason') };
  if (state === 'sent') {
    const raw = flagValue(args, '--tracker');
    if (raw === undefined || !/^\d+$/.test(raw)) fail('mark ... sent needs --tracker N, the tracker row of the application');
    mark.tracker = Number(raw);
  }
  const path = registryPath(root);
  if (readRegistry(path).missing) fail('no registry: run radar.mjs --write first');
  const today = localToday();

  const receipt = await updateRegistry(path, (fresh) => {
    const target = fresh.rows.find((p) => p['key'] === key);
    if (!target) throw new MarkError(`no Prospect with key "${key}"`, CLI_EXIT.NOT_FOUND);
    if (state === 'sent') {
      const tracked = readTrackerRows(root).find((t) => t.num === mark.tracker);
      if (!tracked) throw new MarkError(`tracker row #${mark.tracker} not found`, CLI_EXIT.NOT_FOUND);
      if (!trackerCompanyMatches(target, tracked.company)) {
        throw new MarkError(`tracker row #${mark.tracker} is "${tracked.company}", not "${target.name}"`, CLI_EXIT.NOT_FOUND);
      }
    }
    const cell = applyMark(target, mark, { today });
    const columns = [...fresh.columns, ...RADAR_COLUMNS.filter((c) => !fresh.columns.includes(c))];
    const rows = fresh.rows.map((p) => (p === target ? { ...p, spontaneous: cell } : p));
    return { columns, rows, result: { key, name: target.name, spontaneous: cell } };
  });
  console.log(JSON.stringify(receipt, null, 2));
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const root = getCareerOpsRoot();
  const [command] = positionals(args);
  try {
    if (command === 'next') runNext(args, root);
    else if (command === 'mark') await runMark(args, root);
    else fail('first argument must be next or mark (see --help)');
  } catch (e) {
    if (e instanceof MarkError) fail(e.message, e.exit);
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}
