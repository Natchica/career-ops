import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, parseRegistry, serializeRegistry } from '../radar/registry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const prospect = (over) => ({
  ...Object.fromEntries(RADAR_COLUMNS.map((c) => [c, ''])),
  country: 'FR', size_band: '10-19', signals: '1', sector: '62.01Z', sources: 'sirene',
  first_seen: '2026-10-18', last_seen: '2026-10-18', portals_ref: '—', ...over,
});

const ROWS = [
  prospect({ key: 'acme', name: 'Acme', sites: 'Colmar:A' }),
  prospect({ key: 'beta', name: 'Beta AG', sites: 'Basel:B', country: 'CH', sector: '', size_band: '?', signals: '0', notes: 'met at a fair' }),
  prospect({ key: 'gamma', name: 'Gamma', sites: 'Colmar:A', sector: '56.10A' }),
  prospect({ key: 'delta', name: 'Delta', sites: 'Zug:D', country: 'CH', sector: 'zefix-purpose:software', size_band: '?', spontaneous: 'drafted:2026-10-20' }),
  prospect({ key: 'eps', name: 'Eps', sites: 'Colmar:A', size_band: '1-2' }),
];

function sandbox({ rows = ROWS, blacklist = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-tiers-cli-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  if (rows) writeFileSync(join(dir, 'data', 'radar.tsv'), serializeRegistry({ columns: [...RADAR_COLUMNS], rows }));
  if (blacklist) writeFileSync(join(dir, 'data', 'blacklist.md'), blacklist);
  return dir;
}

function tiers(root, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'radar-tiers.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '' },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}
const file = (root) => join(root, 'data', 'radar.tsv');
const sha = (root) => createHash('sha256').update(readFileSync(file(root))).digest('hex');
const readRows = (root) => parseRegistry(readFileSync(file(root), 'utf-8')).rows;
const byKey = (rows, k) => rows.find((p) => p['key'] === k);

test('a preview classifies, reports and leaves the file byte-identical', () => {
  const root = sandbox();
  const before = sha(root);
  const r = tiers(root, []);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'preview');
  assert.equal(out.written, false);
  assert.equal(out.total, 5);
  assert.deepEqual(out.counts, { 1: 2, 2: 1, 3: 0, out: 2 });
  assert.equal(out.reasons['out sector'], 1);
  assert.equal(out.reasons['out size'], 1);
  assert.equal(out.changed, 5);
  assert.equal(sha(root), before);
});

test('--write sets tier and tier_reason, then a second write changes nothing', () => {
  const root = sandbox();
  const first = JSON.parse(tiers(root, ['--write']).stdout);
  assert.equal(first.written, true);
  const rows = readRows(root);
  assert.equal(byKey(rows, 'acme').tier, '1');
  assert.equal(byKey(rows, 'acme').tier_reason, 'tier 1: zone A, FR, 1 signal');
  assert.equal(byKey(rows, 'gamma').tier, 'out');
  const second = JSON.parse(tiers(root, ['--write']).stdout);
  assert.equal(second.changed, 0);
});

test('--write leaves every cell except tier and tier_reason byte-identical', () => {
  const root = sandbox();
  const before = readRows(root);
  tiers(root, ['--write']);
  const after = readRows(root);
  const untouched = RADAR_COLUMNS.filter((c) => c !== 'tier' && c !== 'tier_reason');
  for (const row of before) {
    const now = byKey(after, row['key']);
    for (const c of untouched) assert.equal(now[c], row[c], `${row['key']}.${c}`);
  }
});

test('a company in data/blacklist.md is out', () => {
  const root = sandbox({ blacklist: '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme | 2026-01-01 | company | test |\n' });
  const out = JSON.parse(tiers(root, []).stdout);
  assert.equal(out.reasons['out blacklist'], 1);
  assert.deepEqual(out.counts, { 1: 1, 2: 1, 3: 0, out: 3 });
});

test('tier_override wins, is never rewritten, and an invalid one is listed', () => {
  const rows = ROWS.map((p) => ({ ...p }));
  rows[0].tier_override = 'out';
  rows[1].tier_override = 'x';
  const root = sandbox({ rows });
  const out = JSON.parse(tiers(root, ['--write']).stdout);
  assert.equal(out.overrides.applied, 1);
  assert.deepEqual(out.overrides.invalid, ['beta']);
  const after = readRows(root);
  assert.equal(byKey(after, 'acme').tier, 'out');
  assert.match(byKey(after, 'acme').tier_reason, /^override: out \(rules: 1,/);
  assert.equal(byKey(after, 'acme').tier_override, 'out');
  assert.equal(byKey(after, 'beta').tier, '2');
});

test('a malformed config/radar-tiers.yml exits 1 with the config error', () => {
  const root = sandbox();
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'radar-tiers.yml'), 'version: [unclosed');
  const r = tiers(root, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /radar-tiers\.yml/);
});

test('a missing registry exits 1 and says to run radar.mjs first', () => {
  const root = sandbox({ rows: null });
  const r = tiers(root, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /radar\.mjs --write first/);
  assert.equal(existsSync(file(root)), false);
});

test('--explain prints the trace and the rank inside the tier, and an unknown key exits 2', () => {
  const root = sandbox();
  const r = tiers(root, ['--explain', 'acme']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.key, 'acme');
  assert.equal(out.tier, '1');
  assert.equal(out.rank, 1);
  assert.deepEqual(out.trace.map((t) => t.rule), ['floor', 'blacklist', 'non-employer', 'sector', 'size', 'zone', 'tier', 'unverified']);
  assert.equal(tiers(root, ['--explain', 'nope']).status, 2);
});

test('--summary prints counts per tier and tier 1 by best zone and country', () => {
  const root = sandbox();
  const r = tiers(root, ['--summary']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tier 1\s+2/);
  assert.match(r.stdout, /A:FR/);
  assert.match(r.stdout, /D:CH/);
  assert.match(r.stdout, /preview only/);
});

test('non-employer and unverified rows are counted in the reasons', () => {
  const root = sandbox({ rows: [
    prospect({ key: 'boeva', name: 'Boeva Lab, ETH Zurich', sources: 'github-orgs', sites: 'Basel:B', country: 'CH' }),
    prospect({ key: 'robo', name: 'Acme Robotics', sources: 'github-orgs', sites: 'Basel:B', country: 'CH' }),
  ] });
  const out = JSON.parse(tiers(root, []).stdout);
  assert.equal(out.reasons['out non-employer'], 1);
  assert.equal(out.reasons.unverified, 1);
});

test('--help prints usage and writes nothing', () => {
  const root = sandbox();
  const before = sha(root);
  const r = tiers(root, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node radar-tiers\.mjs/);
  assert.equal(sha(root), before);
});

test('50k rows classify and serialize in under 3 seconds of cpu', async () => {
  const { loadTierRules, classify } = await import('../radar/tiers.mjs');
  const rules = loadTierRules({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-tiers-perf-')), codeRoot: ROOT });
  const rows = Array.from({ length: 50_000 }, (_, i) => prospect({ key: `c${i}`, name: `Company ${i}`, sites: 'Colmar:A' }));
  const started = process.cpuUsage();
  for (const row of rows) {
    const c = classify(row, rules);
    row.tier = c.tier;
    row.tier_reason = c.reason;
  }
  serializeRegistry({ columns: [...RADAR_COLUMNS], rows });
  const used = process.cpuUsage(started);
  const ms = Math.round((used.user + used.system) / 1000);
  console.log(`radar-tiers 50k round: ${ms} ms cpu`);
  assert.ok(ms < 3000, `took ${ms} ms of cpu`);
});
