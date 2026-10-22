#!/usr/bin/env node
/**
 * radar-enrich.mjs — add relevance hints to the best Radar Prospects.
 *
 *   node radar-enrich.mjs [--limit N] [--zones A,B] [--key k1,k2] [--refresh] [--dry-run] [--summary]
 *
 * For each selected Prospect it reads the firm's public GitHub organisation and
 * its own careers page, then writes the `hints` cell of data/radar.tsv (tokens in
 * radar/hints.mjs). `spontaneous-pick next` and `discover-ats --from-radar` then
 * rank a Prospect with a Java or Rust trace or an open-applications invitation
 * before one without, inside the same zone and country. Reads organisations and
 * company pages only, never people; robots.txt is honoured; a GitHub token is
 * read from GITHUB_PERSONAL_ACCESS_TOKEN and never printed or stored.
 * Preview with --dry-run: nothing is written.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { CLI_EXIT } from './tracker-utils.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { RADAR_COLUMNS, readRegistry, registryPath, updateRegistry } from './radar/registry.mjs';
import { RadarConfigError } from './radar/zones.mjs';
import { loadTierRules } from './radar/tiers.mjs';
import { enrichRow, mergeHints, selectForEnrichment } from './radar/enrich.mjs';
import { hintScore } from './radar/hints.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const KNOWN_FLAGS = ['--limit', '--zones', '--key', '--refresh', '--dry-run', '--summary', '--help'];
const VALUE_FLAGS = ['--limit', '--zones', '--key'];
const BATCH = 8;

const USAGE = `Usage: node radar-enrich.mjs [options]

Read the public GitHub organisation and careers page of the best Radar Prospects
and store relevance hints in data/radar.tsv.

Options:
  --limit <n>     Prospects to probe (default 40, max 200)
  --zones <list>  Zones to cover, default A,B (comma separated, A to D)
  --key <list>    Probe these Prospect keys only (comma separated)
  --refresh       Probe Prospects that were already checked
  --dry-run       Probe and report, write nothing
  --summary       Human-readable output instead of JSON
`;

function fail(message, code = CLI_EXIT.USAGE) {
  console.error(message);
  process.exit(code);
}

function careersLookup(root) {
  const path = join(root, 'portals.yml');
  if (!existsSync(path)) return () => null;
  let doc;
  try { doc = yaml.load(readFileSync(path, 'utf-8')); } catch { return () => null; }
  const byName = new Map();
  for (const c of doc?.tracked_companies ?? []) {
    if (c?.name && c.careers_url && c.enabled !== false) byName.set(String(c.name).toLowerCase(), c.careers_url);
  }
  return (row) => byName.get(String(row.portals_ref || row.name || '').toLowerCase())
    ?? byName.get(String(row.name || '').toLowerCase()) ?? null;
}

export function renderSummary(out) {
  const lines = [`Radar enrich${out.dryRun ? ' (dry run)' : ''}: ${out.probed} probed of ${out.selected} selected; ${out.hinted} with hints`];
  for (const r of out.rows) {
    const note = r.notes.length ? ` · ${r.notes.join('; ')}` : '';
    lines.push(`  ${r.name} (${r.key}) — ${r.hints || 'no hints'}${r.answered ? '' : ' [no source answered]'}${note}`);
  }
  return lines.join('\n');
}

async function main(args) {
  if (args.includes('--help')) { console.log(USAGE); return; }
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  const root = getCareerOpsRoot();

  let limit = 40;
  const rawLimit = flagValue(args, '--limit');
  if (rawLimit !== undefined) {
    limit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1) fail(`--limit takes a number from 1 to 200, got "${rawLimit}"`);
    limit = Math.min(limit, 200);
  }
  const zones = (flagValue(args, '--zones') ?? 'A,B').split(',').map((z) => z.trim().toUpperCase()).filter(Boolean);
  if (zones.length === 0 || zones.some((z) => !/^[A-D]$/.test(z))) fail('--zones takes letters A to D, comma separated');
  const rawKeys = flagValue(args, '--key');
  const keys = rawKeys ? rawKeys.split(',').map((k) => k.trim()).filter(Boolean) : null;
  const dryRun = args.includes('--dry-run');

  let rules;
  try { rules = loadTierRules({ dataRoot: root, codeRoot: CODE_ROOT }); } catch (e) {
    if (e instanceof RadarConfigError) fail(e.message);
    throw e;
  }
  const path = registryPath(root);
  const registry = readRegistry(path);
  if (registry.missing) fail('no registry: run radar.mjs --write first');

  const careersUrlFor = careersLookup(root);
  const hasSource = (row) => careersUrlFor(row) !== null;
  const selected = selectForEnrichment(registry.rows, rules, { zones, limit, keys, refresh: args.includes('--refresh'), hasSource });
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';
  const ctx = {
    http: makeHttpCtx(),
    token,
    careersUrlFor,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: new Date(),
  };
  const today = localToday();
  const results = [];
  let pending = [];

  const persist = async () => {
    if (dryRun || pending.length === 0) { pending = []; return; }
    const batch = pending;
    pending = [];
    await updateRegistry(path, (fresh) => {
      const columns = [...fresh.columns, ...RADAR_COLUMNS.filter((c) => !fresh.columns.includes(c))];
      const byKey = new Map(batch.map((b) => [b.key, b.hints]));
      const rows = fresh.rows.map((p) => (byKey.has(p.key) ? { ...p, hints: byKey.get(p.key) } : p));
      return { columns, rows };
    });
  };

  for (const row of selected) {
    const out = await enrichRow(row, ctx);
    const checked = out.answered || (!out.notes.length && !out.tokens.length);
    const hints = mergeHints(row.hints, out.tokens, today, { checked });
    results.push({ key: row.key, name: row.name, hints, answered: out.answered, notes: out.notes, score: hintScore({ hints }) });
    pending.push({ key: row.key, hints });
    if (pending.length >= BATCH) await persist();
  }
  await persist();

  const out = {
    dryRun,
    selected: selected.length,
    probed: results.length,
    hinted: results.filter((r) => r.score > 0).length,
    rows: results,
  };
  console.log(args.includes('--summary') ? renderSummary(out) : JSON.stringify(out, null, 2));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(CLI_EXIT.ERROR ?? 1);
  });
}
