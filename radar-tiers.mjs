#!/usr/bin/env node
/**
 * radar-tiers.mjs — rank every Prospect in data/radar.tsv into tier 1, 2, 3 or out.
 *
 * Zero network, zero model: it applies templates/radar-tiers.yml (override
 * config/radar-tiers.yml) to the columns the registry already holds and writes
 * `tier` and `tier_reason`. A hand-set `tier_override` always wins and is never
 * rewritten. Preview by default; --write persists. See modes/radar.md.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { findBlacklistEntry, loadBlacklist } from './scan.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { CLI_EXIT } from './tracker-utils.mjs';
import { RADAR_COLUMNS, readRegistry, registryPath, updateRegistry } from './radar/registry.mjs';
import { RadarConfigError } from './radar/zones.mjs';
import { bestZone, classify, compareProspects, loadTierRules, prospectNames } from './radar/tiers.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node radar-tiers.mjs [options]

Rank every Prospect in data/radar.tsv into tier 1, 2, 3 or out, with a recorded
reason. No network, no model. Preview by default: nothing is written unless
--write is given. Rules: templates/radar-tiers.yml (override config/radar-tiers.yml).

Options:
  --write            Persist tier and tier_reason (tier_override is never rewritten)
  --explain <key>    Show the rule trace and the rank inside the tier for one Prospect
  --summary          Human-readable table instead of JSON
  --json             JSON receipt (the default)
  --help             This message
`;

const KNOWN_FLAGS = ['--write', '--explain', '--summary', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--explain'];

const REASON_KEYS = ['out floor', 'out blacklist', 'out sector', 'out size', 'out non-employer', 'unverified', 'unknown', 'override'];

function fail(message, code = CLI_EXIT.USAGE) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function reasonKind(reason) {
  if (reason.startsWith('override')) return 'override';
  if (reason.startsWith('tier 2: unverified employer')) return 'unverified';
  return REASON_KEYS.find((k) => reason.startsWith(k));
}

/** Classify every row; returns new rows (inputs are not mutated) and the receipt parts. */
export function applyTiers(rows, rules, isBlacklisted) {
  const counts = { 1: 0, 2: 0, 3: 0, out: 0 };
  const reasons = Object.fromEntries(REASON_KEYS.map((k) => [k, 0]));
  const tier1 = {};
  const invalid = [];
  let applied = 0;
  let changed = 0;
  const out = rows.map((row) => {
    const c = classify(row, rules, { isBlacklisted });
    counts[c.tier]++;
    const kind = reasonKind(c.reason);
    if (kind) reasons[kind]++;
    if (kind === 'override') applied++;
    if (c.invalidOverride) invalid.push(row['key']);
    if (c.tier === '1') {
      const slot = `${bestZone(row, rules)}:${row.country}`;
      tier1[slot] = (tier1[slot] ?? 0) + 1;
    }
    if (row.tier !== c.tier || row.tier_reason !== c.reason) changed++;
    return { ...row, tier: c.tier, tier_reason: c.reason };
  });
  return { rows: out, counts, reasons, tier1, overrides: { applied, invalid }, changed };
}

function renderSummary(receipt) {
  const lines = [`Radar tiers ${receipt.mode} — ${receipt.total} Prospects, ${receipt.changed} changed (${receipt.rules})`];
  for (const t of ['1', '2', '3', 'out']) lines.push(`  tier ${t}`.padEnd(12) + String(receipt.counts[t]).padStart(7));
  lines.push('  reasons');
  for (const [k, n] of Object.entries(receipt.reasons)) if (n > 0) lines.push(`    ${k.padEnd(18)}${String(n).padStart(7)}`);
  lines.push('  tier 1 by best zone and country');
  for (const [k, n] of Object.entries(receipt.tier1).sort()) lines.push(`    ${k.padEnd(18)}${String(n).padStart(7)}`);
  if (receipt.overrides.applied) lines.push(`  overrides applied: ${receipt.overrides.applied}`);
  if (receipt.overrides.invalid.length) lines.push(`  invalid tier_override ignored: ${receipt.overrides.invalid.join(', ')}`);
  lines.push(receipt.written ? '  written to data/radar.tsv' : '  preview only — rerun with --write to save');
  return lines.join('\n');
}

function explain(rows, key, rules, isBlacklisted) {
  const row = rows.find((p) => p['key'] === key);
  if (!row) fail(`no Prospect with key "${key}"`, CLI_EXIT.NOT_FOUND);
  const c = classify(row, rules, { isBlacklisted });
  let rank = null;
  if (c.tier === '1' || c.tier === '2' || c.tier === '3') {
    const same = rows
      .filter((p) => classify(p, rules, { isBlacklisted }).tier === c.tier)
      .sort((a, b) => compareProspects(a, b, rules));
    rank = same.findIndex((p) => p['key'] === key) + 1;
  }
  return {
    key, name: row.name, tier: c.tier, tier_reason: c.reason, rank,
    tier_override: row.tier_override || null, invalidOverride: c.invalidOverride, trace: c.trace,
  };
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const root = getCareerOpsRoot();
  const path = registryPath(root);
  const write = hasFlag(args, '--write');

  let rules;
  try {
    rules = loadTierRules({ dataRoot: root, codeRoot: CODE_ROOT });
  } catch (e) {
    if (e instanceof RadarConfigError) fail(e.message);
    throw e;
  }
  const blacklist = loadBlacklist(join(root, 'data', 'blacklist.md'));
  const isBlacklisted = (row) => prospectNames(row).some((n) => findBlacklistEntry(blacklist, n, '') !== null);

  const existing = readRegistry(path);
  if (existing.missing) fail(`no registry at ${path}: run radar.mjs --write first`);

  const explainKey = flagValue(args, '--explain');
  if (explainKey !== undefined) {
    console.log(JSON.stringify(explain(existing.rows, explainKey, rules, isBlacklisted), null, 2));
    return;
  }

  let result = applyTiers(existing.rows, rules, isBlacklisted);
  if (write) {
    // Classify the rows on disk now, under the lock, so a mark written meanwhile survives.
    result = await updateRegistry(path, (fresh) => {
      const applied = applyTiers(fresh.rows, rules, isBlacklisted);
      const columns = [...fresh.columns, ...RADAR_COLUMNS.filter((c) => !fresh.columns.includes(c))];
      return { columns, rows: applied.rows, result: applied };
    });
  }

  const receipt = {
    mode: write ? 'write' : 'preview',
    rules: rules.source,
    total: result.rows.length,
    counts: result.counts,
    reasons: result.reasons,
    tier1: result.tier1,
    overrides: result.overrides,
    changed: result.changed,
    written: write,
  };
  console.log(hasFlag(args, '--summary') ? renderSummary(receipt) : JSON.stringify(receipt, null, 2));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}
