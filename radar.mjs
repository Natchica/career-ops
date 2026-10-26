#!/usr/bin/env node
/**
 * radar.mjs — census of the employers in the commute zones A-D.
 *
 * Names companies and does nothing else with them: no board resolution, no
 * scoring, no screening, no outreach. Each source yields raw records, the zone
 * table places them, identity groups them into one Prospect per brand, and the
 * registry data/radar.tsv records them. The default run is a preview that
 * writes nothing; --write persists. See modes/radar.md and CONTEXT.md.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadYaml } from './lib/yaml-document.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { buildCompanyCanonicalizer } from './scan.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { loadZoneTable, zoneRecord } from './radar/zones.mjs';
import { baseKey, mergeRecords } from './radar/identity.mjs';
import { RADAR_COLUMNS, readRegistry, registryPath, updateRegistry } from './radar/registry.mjs';
import { makeRawCache } from './radar/cache.mjs';
import { computeCoverage } from './radar/coverage.mjs';
import { makeHttpCtx } from './providers/_http.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node radar.mjs [options]

Census of the employers with a site in commute zones A to D. Names companies
and does nothing else with them. Preview by default: nothing is written unless
--write is given.

Options:
  --source <id|all>  Source to run (default: all). Ids come from radar/sources/
  --zone <A,B,C,D>   Keep only sites in these zones
  --sources          List the sources with their auth state and last save (JSON)
  --coverage         Recall against the companies already known to be in a zone
  --write            Persist the registry (data/radar.tsv)
  --resume           Reuse sweeps stored in the last 24 hours (--write does too)
  --since <date>     Also report prospects first seen on or after YYYY-MM-DD
  --summary          Human-readable table instead of JSON
  --json             JSON receipt (the default)
  --help             This message
`;

const KNOWN_FLAGS = ['--source', '--zone', '--write', '--resume', '--sources', '--coverage', '--since', '--summary', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--source', '--zone', '--since'];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function loadSources() {
  const dir = join(CODE_ROOT, 'radar', 'sources');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const sources = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (mod.default?.id) sources.push(mod.default);
  }
  return sources;
}

function authState(source, env) {
  if (source.disabled) return { ready: false, reason: source.disabled, notBuilt: true };
  if (source.auth?.kind !== 'env') return { ready: true };
  const missing = (source.auth.vars ?? []).filter((v) => !env[v]);
  return missing.length ? { ready: false, reason: `missing credentials: ${missing.join(', ')}` } : { ready: true };
}

/**
 * Every source with its auth state and the latest date it named a Prospect.
 * Reports which variables a source needs, never their values.
 */
function describeSources(sources, rows, env) {
  return sources.map((source) => {
    const state = authState(source, env);
    const seen = rows.filter((r) => String(r.sources ?? '').split(';').includes(source.id)).map((r) => r.last_seen).filter(Boolean);
    return {
      id: source.id,
      family: source.family,
      auth: state.ready ? 'ready' : state.notBuilt ? 'not-built' : 'missing-credentials',
      reason: state.ready || !state.notBuilt ? null : state.reason,
      vars: source.auth?.vars ?? [],
      lastSaved: seen.length ? seen.sort().at(-1) : null,
    };
  });
}

function loadPortals(root) {
  const path = process.env.CAREER_OPS_PORTALS || join(root, 'portals.yml');
  if (!existsSync(path)) return {};
  try {
    return loadYaml(readFileSync(path, 'utf-8')) || {};
  } catch (e) {
    throw new Error(`${path}: ${e.message}`);
  }
}

function renderCoverage(c) {
  const pct = (n) => (n === null ? 'n/a (no baseline)' : `${(n * 100).toFixed(1)}%`);
  const lines = [
    `Radar coverage - baseline of ${c.baseline.size} companies known to be in zones A to D`,
    `  recall, all sources:  ${pct(c.recall_all)} (${c.found} of ${c.baseline.size})`,
    `  recall, registers and other sources only: ${pct(c.recall_excluding_ats_employers)}`,
    `  not in the radar yet: ${c.missing_total}${c.missing.length ? ` (${c.missing.slice(0, 10).join(', ')}${c.missing_total > 10 ? ', ...' : ''})` : ''}`,
  ];
  if (c.baseline.unzoned) lines.push(`  tracked companies that cannot be placed in a zone: ${c.baseline.unzoned}`);
  return lines.join('\n');
}

async function coverageReport(root, table, canon, portals) {
  const source = (await loadSources()).find((s) => s.id === 'ats-employers');
  const records = [];
  try {
    for await (const record of source.fetch({ env: process.env, dataRoot: root })) records.push(record);
  } catch {
    // No scan history yet: the baseline is simply empty.
  }
  const portalsNames = (portals.tracked_companies || []).map((e) => e?.name).filter((n) => typeof n === 'string');
  return computeCoverage({ records, portalsNames, rows: readRegistry(registryPath(root)).rows, table, canon });
}

function renderSummary(receipt) {
  const lines = [`Radar ${receipt.mode} — ${receipt.prospects.new} new, ${receipt.prospects.known} known, ${receipt.prospects.total} total`];
  for (const s of receipt.sources) {
    lines.push(`  ${s.id.padEnd(16)} ${s.status.padEnd(8)} raw ${s.raw} · zoned ${s.zoned} · unzoned ${s.unzoned}${s.reason ? ` · ${s.reason}` : ''}`);
  }
  if (receipt.since) lines.push(`  first seen since ${receipt.since.date}: ${receipt.since.count}`);
  for (const c of receipt.collisions) lines.push(`  collision: "${c.name}" kept apart as ${c.resolvedKey}`);
  lines.push(receipt.written ? '  written to data/radar.tsv' : '  preview only — rerun with --write to save');
  return lines.join('\n');
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const sourceArg = flagValue(args, '--source') ?? 'all';
  const zoneArg = flagValue(args, '--zone');
  const sinceArg = flagValue(args, '--since');
  const write = hasFlag(args, '--write');
  const useCache = write || hasFlag(args, '--resume');

  let zones = null;
  if (zoneArg !== undefined) {
    zones = zoneArg.split(',').map((z) => z.trim().toUpperCase());
    if (!zones.length || zones.some((z) => !['A', 'B', 'C', 'D'].includes(z))) fail(`--zone takes letters from A to D, got "${zoneArg}"`);
  }
  if (sinceArg !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) fail(`--since takes YYYY-MM-DD, got "${sinceArg}"`);

  if (hasFlag(args, '--coverage')) {
    const root = getCareerOpsRoot();
    const portals = loadPortals(root);
    const report = await coverageReport(root, loadZoneTable({ dataRoot: root, codeRoot: CODE_ROOT }), buildCompanyCanonicalizer(portals.company_aliases), portals);
    console.log(hasFlag(args, '--summary') ? renderCoverage(report) : JSON.stringify(report, null, 2));
    return;
  }

  const all = await loadSources();
  if (hasFlag(args, '--sources')) {
    const registry = readRegistry(registryPath(getCareerOpsRoot()));
    console.log(JSON.stringify(describeSources(all, registry.rows, process.env), null, 2));
    return;
  }
  const selected = sourceArg === 'all' ? all : all.filter((s) => s.id === sourceArg);
  if (selected.length === 0) fail(`unknown source "${sourceArg}". Known: ${all.map((s) => s.id).join(', ')}`);

  const root = getCareerOpsRoot();
  const today = localToday();
  const table = loadZoneTable({ dataRoot: root, codeRoot: CODE_ROOT });
  const path = registryPath(root);
  const existing = readRegistry(path);

  const portals = loadPortals(root);
  const canon = buildCompanyCanonicalizer(portals.company_aliases);
  const portalsNames = new Map();
  for (const entry of portals.tracked_companies || []) {
    if (entry && typeof entry.name === 'string') portalsNames.set(baseKey(canon(entry.name)), entry.name);
  }

  const baseCtx = {
    table, zones, env: process.env, today, dataRoot: root, codeRoot: CODE_ROOT,
    http: makeHttpCtx(),
    log: (message) => process.stderr.write(`${message}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  const zoned = [];
  const receipts = [];
  for (const source of selected) {
    const receipt = { id: source.id, status: 'ok', reason: null, raw: 0, zoned: 0, unzoned: 0 };
    receipts.push(receipt);
    const auth = authState(source, process.env);
    if (!auth.ready) {
      Object.assign(receipt, { status: 'skipped', reason: auth.reason });
      continue;
    }
    const fromSource = [];
    const ctx = { ...baseCtx, cache: makeRawCache({ root, sourceId: source.id, useCache }) };
    try {
      for await (const raw of source.fetch(ctx)) {
        receipt.raw++;
        const record = zoneRecord(table, raw);
        if (record.sites.length === 0) { receipt.unzoned++; continue; }
        if (zones) {
          record.sites = record.sites.filter((s) => zones.includes(s.zone));
          if (record.sites.length === 0) continue;
        }
        receipt.zoned++;
        fromSource.push(record);
      }
      zoned.push(...fromSource);
    } catch (e) {
      Object.assign(receipt, { status: 'failed', reason: e?.message ?? String(e) });
    }
  }

  const mergeInto = (rows) => mergeRecords(rows, zoned, { canon, today, portalsNames });
  const anyOk = receipts.some((r) => r.status === 'ok');
  let merged = mergeInto(existing.rows);
  let written = false;
  if (write && anyOk) {
    // The sweep can take minutes: merge into the rows on disk now, under the lock,
    // so a mark or override written meanwhile is not overwritten with stale rows.
    merged = await updateRegistry(path, (fresh) => {
      const result = mergeInto(fresh.rows);
      const columns = [...fresh.columns, ...RADAR_COLUMNS.filter((c) => !fresh.columns.includes(c))];
      return { columns, rows: result.rows, result };
    });
    written = true;
  }

  const out = {
    mode: write ? 'write' : 'preview',
    sources: receipts,
    prospects: { new: merged.newKeys.length, known: merged.knownKeys.length, total: merged.rows.length },
    collisions: merged.collisions,
    written,
  };
  if (sinceArg !== undefined) {
    out.since = { date: sinceArg, count: merged.rows.filter((r) => r.first_seen >= sinceArg).length };
  }
  console.log(hasFlag(args, '--summary') ? renderSummary(out) : JSON.stringify(out, null, 2));
  if (!anyOk) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}
