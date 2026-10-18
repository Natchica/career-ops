import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, parseRegistry, serializeRegistry } from '../radar/registry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'radar', 'scan-history.tsv');
const sandboxes = [];

function sandbox({ withHistory = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-cli-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  if (withHistory) copyFileSync(FIXTURE, join(dir, 'data', 'scan-history.tsv'));
  return dir;
}
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function radar(root, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'radar.mjs'), ...args], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_DATA_DIR: '',
      CAREER_OPS_PORTALS: '',
      CAREER_OPS_SCAN_HISTORY: '',
    },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}
const receipt = (r) => JSON.parse(r.stdout);
const registryFile = (root) => join(root, 'data', 'radar.tsv');
const readRows = (root) => parseRegistry(readFileSync(registryFile(root), 'utf-8')).rows;

test('a preview reports what it would add and writes nothing', () => {
  const root = sandbox();
  const r = radar(root, ['--source', 'ats-employers']);
  assert.equal(r.status, 0, r.stderr);
  const out = receipt(r);
  assert.equal(out.mode, 'preview');
  assert.equal(out.written, false);
  assert.deepEqual(out.prospects, { new: 2, known: 0, total: 2 });
  assert.deepEqual(out.sources[0], { id: 'ats-employers', status: 'ok', reason: null, raw: 5, zoned: 3, unzoned: 2 });
  assert.equal(existsSync(registryFile(root)), false);
});

test('--write persists the registry', () => {
  const root = sandbox();
  const r = radar(root, ['--source', 'ats-employers', '--write']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(receipt(r).written, true);
  const rows = readRows(root);
  assert.deepEqual(rows.map((row) => row.key).sort(), ['acme', 'beta']);
  const acme = rows.find((row) => row.key === 'acme');
  assert.equal(acme.sites, 'Basel:B;Zurich:C');
  assert.equal(acme.signals, '1');
  assert.equal(acme.portals_ref, '—');
});

test('a second --write adds nothing and keeps first_seen', () => {
  const root = sandbox();
  radar(root, ['--source', 'ats-employers', '--write']);
  const before = readRows(root).map((row) => row.first_seen);
  const again = receipt(radar(root, ['--source', 'ats-employers', '--write']));
  assert.equal(again.prospects.new, 0);
  assert.equal(again.prospects.known, 2);
  assert.deepEqual(readRows(root).map((row) => row.first_seen), before);
});

test('--zone keeps only the sites in the chosen zones', () => {
  const root = sandbox();
  const out = receipt(radar(root, ['--source', 'ats-employers', '--zone', 'C']));
  assert.deepEqual(out.prospects, { new: 1, known: 0, total: 1 });
});

test('--since reports prospects first seen on or after the date', () => {
  const root = sandbox();
  radar(root, ['--source', 'ats-employers', '--write']);
  const none = receipt(radar(root, ['--source', 'ats-employers', '--since', '2999-01-01']));
  assert.deepEqual(none.since, { date: '2999-01-01', count: 0 });
  const all = receipt(radar(root, ['--source', 'ats-employers', '--since', '2000-01-01']));
  assert.equal(all.since.count, 2);
});

test('an unknown source or a bad flag value exits 1 with a message', () => {
  const root = sandbox();
  const unknown = radar(root, ['--source', 'nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown source "nope"/);
  assert.equal(radar(root, ['--zone', 'Z']).status, 1);
  assert.equal(radar(root, ['--since', 'yesterday']).status, 1);
  assert.equal(radar(root, ['--bogus']).status, 1);
});

test('a failing source is reported and does not abort the run', () => {
  const root = sandbox({ withHistory: false });
  const r = radar(root, ['--source', 'ats-employers']);
  assert.equal(r.status, 1);
  const out = receipt(r);
  assert.equal(out.sources[0].status, 'failed');
  assert.match(out.sources[0].reason, /scan-history\.tsv/);
  assert.equal(out.written, false);
});

test('--help prints usage', () => {
  const r = radar(sandbox(), ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage:/m);
});

test('a malformed registry is an error, never an empty default', () => {
  const root = sandbox();
  writeFileSync(registryFile(root), 'name\nAcme\n');
  const r = radar(root, ['--source', 'ats-employers', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /radar\.tsv/);
  assert.equal(readFileSync(registryFile(root), 'utf-8'), 'name\nAcme\n');
});

test('--resume is accepted and documented', () => {
  const root = sandbox();
  assert.match(radar(root, ['--help']).stdout, /--resume/);
  const r = radar(root, ['--source', 'ats-employers', '--resume']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(receipt(r).mode, 'preview');
});

test('every source in radar/sources is listed as known when an unknown one is asked for', () => {
  const unknown = radar(sandbox(), ['--source', 'nope']);
  assert.match(unknown.stderr, /ats-employers/);
  assert.match(unknown.stderr, /sirene/);
});

test('--sources lists every source with its auth state and last save', () => {
  const root = sandbox();
  const before = JSON.parse(radar(root, ['--sources']).stdout);
  const ats = before.find((s) => s.id === 'ats-employers');
  assert.deepEqual(
    { family: ats.family, auth: ats.auth, vars: ats.vars, lastSaved: ats.lastSaved },
    { family: 'ats', auth: 'ready', vars: [], lastSaved: null },
  );
  assert.ok(before.some((s) => s.id === 'sirene' && s.family === 'register'));
  radar(root, ['--source', 'ats-employers', '--write']);
  const after = JSON.parse(radar(root, ['--sources']).stdout);
  assert.match(after.find((s) => s.id === 'ats-employers').lastSaved, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(after.find((s) => s.id === 'sirene').lastSaved, null);
});

test('--sources never prints a credential value', () => {
  const root = sandbox();
  const r = spawnSync(process.execPath, [join(ROOT, 'radar.mjs'), '--sources'], {
    cwd: root, encoding: 'utf-8',
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', ZEFIX_PASSWORD: 'SECRET_SENTINEL_42', GITHUB_PERSONAL_ACCESS_TOKEN: 'SECRET_SENTINEL_42' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes('SECRET_SENTINEL_42'), false);
  assert.equal(r.stderr.includes('SECRET_SENTINEL_42'), false);
});

test('a source with no vetted site is reported as skipped with its reason', () => {
  const root = sandbox();
  const r = radar(root, ['--source', 'directories']);
  const out = receipt(r);
  assert.equal(out.sources[0].status, 'skipped');
  assert.match(out.sources[0].reason, /no vetted site/);
  assert.equal(out.written, false);
});

test('--sources marks a source with no vetted site as not built and says why', () => {
  const root = sandbox();
  const list = JSON.parse(radar(root, ['--sources']).stdout);
  const dirs = list.find((s) => s.id === 'directories');
  assert.equal(dirs.auth, 'not-built');
  assert.match(dirs.reason, /no vetted site/);
  assert.equal(list.find((s) => s.id === 'sirene').reason, null);
});

test('--coverage reports recall against the scan-history baseline', () => {
  const root = sandbox();
  const acme = Object.fromEntries(RADAR_COLUMNS.map((c) => [c, '']));
  Object.assign(acme, { key: 'acme', name: 'Acme AG', sites: 'Basel:B', country: 'CH', size_band: '?', signals: '0', sources: 'sirene', first_seen: '2026-10-18', last_seen: '2026-10-18', portals_ref: '—' });
  writeFileSync(registryFile(root), serializeRegistry({ columns: [...RADAR_COLUMNS], rows: [acme] }));
  const r = radar(root, ['--coverage']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.baseline.size, 2, 'Acme and Beta are in zone; Gamma is remote and Delta has no location');
  assert.equal(out.recall_all, 0.5);
  assert.equal(out.recall_excluding_ats_employers, 0.5);
  assert.deepEqual(out.missing, ['Beta SAS']);
});

test('--coverage without any registry or history is an empty baseline, not an error', () => {
  const root = sandbox({ withHistory: false });
  const r = radar(root, ['--coverage']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).recall_all, null);
});

test('--coverage --summary prints both recall figures in words', () => {
  const root = sandbox();
  const r = radar(root, ['--coverage', '--summary']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recall/i);
  assert.match(r.stdout, /registers/i);
});
