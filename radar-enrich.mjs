#!/usr/bin/env node
/**
 * radar-enrich.mjs — add relevance hints to the best Radar Prospects.
 *
 *   node radar-enrich.mjs [--limit N] [--zones A,B] [--key k1,k2] [--refresh] [--sites] [--dry-run] [--summary]
 *
 * For each selected Prospect it reads the firm's public GitHub organisation and
 * its own careers page, then writes the `hints` cell of data/radar.tsv (tokens in
 * radar/hints.mjs). With --sites it runs the Site probe instead, on the register-only
 * Prospects: it guesses the firm's domain from its registered name, keeps the first
 * one whose page names the firm as `web:{domain}`, or `site:none`, and reads its
 * home and careers pages for hint tokens. `spontaneous-pick next` and `discover-ats --from-radar` then
 * rank a Prospect with a Java or Rust trace or an open-applications invitation
 * before one without, inside the same zone and country. Reads organisations and
 * company pages only, never people; robots.txt is honoured; a GitHub token is
 * read from GITHUB_PERSONAL_ACCESS_TOKEN and never printed or stored.
 * Preview with --dry-run: nothing is written.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './lib/yaml-document.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { CLI_EXIT } from './tracker-utils.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { RADAR_COLUMNS, readRegistry, registryPath, updateRegistry } from './radar/registry.mjs';
import { RadarConfigError, loadZoneTable } from './radar/zones.mjs';
import { loadTierRules } from './radar/tiers.mjs';
import { enrichRow, mergeHints, selectForEnrichment, siteProbeRow } from './radar/enrich.mjs';
import { hintScore } from './radar/hints.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const KNOWN_FLAGS = ['--limit', '--zones', '--key', '--refresh', '--sites', '--dry-run', '--summary', '--help'];
const VALUE_FLAGS = ['--limit', '--zones', '--key'];
const BATCH = 8;

const USAGE = `Usage: node radar-enrich.mjs [options]

Read the public GitHub organisation and careers page of the best Radar Prospects
and store relevance hints in data/radar.tsv.

Options:
  --limit <n>     Prospects to probe (default 40, max 200)
  --zones <list>  Zones to cover, default A,B, or B with --sites (comma separated, A to D)
  --key <list>    Probe these Prospect keys only (comma separated)
  --refresh       Probe Prospects that were already checked
  --sites         Site probe: find and verify the website of register-only Prospects
                  (no GitHub organisation, no portals.yml entry), up to 6 guessed domains each
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
  try { doc = loadYaml(readFileSync(path, 'utf-8')); } catch { return () => null; }
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

/**
 * Probe each selected Prospect with `probe(row, ctx)` and hand the new `hints`
 * cells to `persist` in batches, so an interrupted run loses at most one batch
 * and the next run resumes from the `checked:` markers. A Prospect that no source
 * answered gets no `checked:` token and is selected again.
 *
 * @returns {Promise<{key:string, name:string, hints:string, answered:boolean, notes:string[], score:number}[]>}
 */
export async function probeRows(selected, { probe, ctx, today, persist, batch = BATCH }) {
  const results = [];
  let pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const chunk = pending;
    pending = [];
    await persist(chunk);
  };
  for (const row of selected) {
    const out = await probe(row, ctx);
    const checked = out.answered || (!out.notes.length && !out.tokens.length);
    const hints = mergeHints(row.hints, out.tokens, today, { checked });
    results.push({ key: row.key, name: row.name, hints, answered: out.answered, notes: out.notes, score: hintScore({ hints }) });
    pending.push({ key: row.key, hints });
    if (pending.length >= batch) await flush();
  }
  await flush();
  return results;
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
  const sites = args.includes('--sites');
  const zones = (flagValue(args, '--zones') ?? (sites ? 'B' : 'A,B')).split(',').map((z) => z.trim().toUpperCase()).filter(Boolean);
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
  const selected = selectForEnrichment(registry.rows, rules, { zones, limit, keys, refresh: args.includes('--refresh'), hasSource, sites });
  const ctx = {
    http: makeHttpCtx(),
    token: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
    careersUrlFor,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: new Date(),
  };
  if (sites) {
    try { ctx.table = loadZoneTable({ dataRoot: root, codeRoot: CODE_ROOT }); } catch (e) {
      if (e instanceof RadarConfigError) fail(e.message);
      throw e;
    }
  }

  const persist = async (batch) => {
    if (dryRun) return;
    await updateRegistry(path, (fresh) => {
      const columns = [...fresh.columns, ...RADAR_COLUMNS.filter((c) => !fresh.columns.includes(c))];
      const byKey = new Map(batch.map((b) => [b.key, b.hints]));
      const rows = fresh.rows.map((p) => (byKey.has(p.key) ? { ...p, hints: byKey.get(p.key) } : p));
      return { columns, rows };
    });
  };
  const results = await probeRows(selected, { probe: sites ? siteProbeRow : enrichRow, ctx, today: localToday(), persist });

  const out = {
    dryRun,
    mode: sites ? 'sites' : 'hints',
    zones,
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
