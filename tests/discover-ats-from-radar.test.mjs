import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, serializeRegistry } from '../radar/registry.mjs';
import { loadTierRules, selectForDiscovery } from '../radar/tiers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const prospect = (over) => ({
  ...Object.fromEntries(RADAR_COLUMNS.map((c) => [c, ''])),
  country: 'FR', size_band: '10-19', signals: '1', sector: '62.01Z', sources: 'sirene', sites: 'Colmar:A',
  portals_ref: '—', tier: '1', ...over,
});

function sandbox(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'discover-from-radar-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  if (rows) writeFileSync(join(dir, 'data', 'radar.tsv'), serializeRegistry({ columns: [...RADAR_COLUMNS], rows }));
  return dir;
}

function discover(root, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'discover-ats.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: join(root, 'portals.yml') },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}

// ---- selection ---------------------------------------------------------------

const rules = loadTierRules({ dataRoot: mkdtempSync(join(tmpdir(), 'discover-rules-')), codeRoot: ROOT });
const names = (rows, opts = {}) => selectForDiscovery(rows, rules, { zones: null, limit: 20, ...opts }).map((p) => p.name);

test('only tier 1 and 2 Prospects without a board are selected', () => {
  const rows = [
    prospect({ name: 'One', tier: '1' }),
    prospect({ name: 'Two', tier: '2', signals: '0' }),
    prospect({ name: 'Three', tier: '3' }),
    prospect({ name: 'Gone', tier: 'out' }),
    prospect({ name: 'Untiered', tier: '' }),
    prospect({ name: 'HasBoard', portals_ref: 'HasBoard' }),
    prospect({ name: 'Scanned', sources: 'sirene;ats-employers;ats-employers:board' }),
  ];
  assert.deepEqual(names(rows), ['One', 'Two']);
});

test('the zone filter keeps a Prospect with any site in a wanted zone', () => {
  const rows = [
    prospect({ name: 'Colmar Co', sites: 'Colmar:A' }),
    prospect({ name: 'Basel Co', sites: 'Basel:B' }),
    prospect({ name: 'Both Co', sites: 'Zug:D;Basel:B' }),
  ];
  assert.deepEqual(names(rows, { zones: ['B'] }).sort(), ['Basel Co', 'Both Co']);
  assert.deepEqual(names(rows, { zones: ['A', 'D'] }).sort(), ['Both Co', 'Colmar Co']);
});

test('selection follows the tier order and stops at the limit', () => {
  const rows = [
    prospect({ key: 'z', name: 'Zone B', sites: 'Basel:B' }),
    prospect({ key: 'a', name: 'Zone A', sites: 'Colmar:A' }),
    prospect({ key: 't2', name: 'Tier Two', tier: '2', signals: '0', sites: 'Colmar:A' }),
  ];
  assert.deepEqual(names(rows), ['Zone A', 'Zone B', 'Tier Two']);
  assert.deepEqual(names(rows, { limit: 2 }), ['Zone A', 'Zone B']);
});

// ---- command line ------------------------------------------------------------

test('--zone and --limit need --from-radar', () => {
  const root = sandbox([prospect({ name: 'X' })]);
  assert.equal(discover(root, ['--zone', 'A']).status, 1);
  assert.equal(discover(root, ['--limit', '5']).status, 1);
});

test('--from-radar cannot be combined with --in or company names', () => {
  const root = sandbox([prospect({ name: 'X' })]);
  assert.equal(discover(root, ['--from-radar', 'Acme']).status, 1);
  assert.equal(discover(root, ['--from-radar', '--in', 'x.yml']).status, 1);
});

test('--limit must be a whole number from 1 to 200 and --zone takes letters A to D', () => {
  const root = sandbox([prospect({ name: 'X' })]);
  for (const bad of ['0', '201', 'abc', '2.5']) assert.equal(discover(root, ['--from-radar', '--limit', bad]).status, 1, `limit ${bad}`);
  assert.equal(discover(root, ['--from-radar', '--zone', 'Z']).status, 1);
});

test('a missing registry exits 1 and points at radar.mjs', () => {
  const root = sandbox(null);
  const r = discover(root, ['--from-radar']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /radar\.mjs --write first/);
});

test('no eligible Prospect prints the zero-company envelope and writes nothing', () => {
  const root = sandbox([prospect({ name: 'Gone', tier: 'out' })]);
  const r = discover(root, ['--from-radar', '--zone', 'A', '--limit', '5']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.metadata.written, false);
  assert.equal(out.metadata.resolved, 0);
  assert.deepEqual(out.resolved, []);
});
