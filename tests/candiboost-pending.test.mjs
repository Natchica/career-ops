import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, serializeRegistry } from '../radar/registry.mjs';
import { PENDING_COLUMNS, parseTable } from '../lib/candiboost.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const prospect = (over) => ({
  ...Object.fromEntries(RADAR_COLUMNS.map((c) => [c, ''])),
  country: 'CH', size_band: '10-19', signals: '1', sources: 'x', sites: 'Basel:B',
  first_seen: '2026-10-18', last_seen: '2026-10-18', portals_ref: '—', tier: '1', tier_reason: 'tier 1', ...over,
});

const TRACKER_HEAD = '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
const trackerRow = (num, company) => `| ${num} | 2026-10-01 | ${company} | — | Dev | 4.0/5 | Applied | ✅ | — | n | |\n`;

function sandbox({ rows = [], tracker = '', blacklist = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'candiboost-pending-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'radar.tsv'), serializeRegistry({ columns: [...RADAR_COLUMNS], rows }));
  writeFileSync(join(dir, 'data', 'applications.md'), TRACKER_HEAD + tracker);
  if (blacklist) writeFileSync(join(dir, 'data', 'blacklist.md'), blacklist);
  return dir;
}

function run(root, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'candiboost-pending.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}

const pendingFile = (root) => join(root, 'data', 'candiboost-pending.tsv');
const readPending = (root) => parseTable(readFileSync(pendingFile(root), 'utf-8'), { key: 'company', columns: PENDING_COLUMNS }).rows;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function ingest(root, input, name = 'in.json') {
  const path = join(root, name);
  writeFileSync(path, typeof input === 'string' ? input : JSON.stringify(input));
  return run(root, ['ingest', path]);
}

const RADAR = [
  prospect({ key: 'adesso schweiz', name: 'adesso Schweiz' }),
  prospect({ key: 'pistor', name: 'Pistor', tier: '2' }),
];

test('ingest keeps only "En attente" rows, folds duplicates and matches the Radar', () => {
  const root = sandbox({ rows: RADAR });
  const r = ingest(root, [
    { company: 'adesso Schweiz', status: 'En attente' },
    { company: 'Pistor', status: 'Envoyée' },
    { company: ' Acme  AG ', status: 'en attente' },
    { company: 'adesso Schweiz', status: 'En attente' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  const rows = readPending(root);
  assert.deepEqual(rows.map((x) => x.company), ['adesso Schweiz', 'Acme AG']);
  assert.equal(rows[0].radar_key, 'adesso schweiz');
  assert.equal(rows[1].radar_key, '');
  assert.deepEqual(JSON.parse(r.stdout), { new: 2, kept: 0, dropped: 0, total: 2 });
});

test('ingest accepts an accent-less or upper-case status', () => {
  const root = sandbox();
  ingest(root, [{ company: 'A', status: 'EN ATTENTE' }, { company: 'B', status: 'En  attente' }, { company: 'C', status: 'Envoye' }]);
  assert.deepEqual(readPending(root).map((x) => x.company), ['A', 'B']);
});

test('re-ingest replaces the list, keeps first_seen of survivors and counts the dropped', () => {
  const root = sandbox({ rows: RADAR });
  ingest(root, [{ company: 'adesso Schweiz', status: 'En attente' }, { company: 'Acme AG', status: 'En attente' }]);
  const text = readFileSync(pendingFile(root), 'utf-8').split('\n');
  const old = text.map((l) => l.replace(/\t\d{4}-\d{2}-\d{2}\t\d{4}-\d{2}-\d{2}$/, '\t2026-01-05\t2026-01-05')).join('\n');
  writeFileSync(pendingFile(root), old);
  const r = ingest(root, [{ company: 'adesso Schweiz', status: 'En attente' }, { company: 'New SA', status: 'En attente' }]);
  assert.deepEqual(JSON.parse(r.stdout), { new: 1, kept: 1, dropped: 1, total: 2 });
  const rows = readPending(root);
  assert.deepEqual(rows.map((x) => x.company), ['adesso Schweiz', 'New SA']);
  assert.equal(rows[0].first_seen, '2026-01-05');
  assert.notEqual(rows[0].last_seen, '2026-01-05');
});

test('a malformed input exits 1 and leaves the file byte-identical', () => {
  const root = sandbox();
  ingest(root, [{ company: 'Keep Me', status: 'En attente' }]);
  const before = sha(pendingFile(root));
  assert.equal(ingest(root, { company: 'x' }).status, 1);
  assert.equal(ingest(root, [{ status: 'En attente' }]).status, 1);
  assert.equal(ingest(root, '{not json').status, 1);
  assert.equal(run(root, ['ingest', join(root, 'missing.json')]).status, 1);
  assert.equal(sha(pendingFile(root)), before);
});

test('--help prints usage and an unknown flag exits 1', () => {
  const root = sandbox();
  const r = run(root, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node candiboost-pending\.mjs/);
  assert.equal(run(root, ['rank', '--nope']).status, 1);
});

// ---- rank -------------------------------------------------------------------

const RANK_RADAR = [
  ...RADAR,
  prospect({ key: 'tracked co', name: 'Tracked Co' }),
  prospect({ key: 'black co', name: 'Black Co' }),
  prospect({ key: 'marked co', name: 'Marked Co', spontaneous: 'drafted:2026-10-20' }),
  prospect({ key: 'gone', name: 'Gone', tier: 'out' }),
  prospect({ key: 'tier three', name: 'Tier Three', tier: '3' }),
];
const PAGE = [
  'Zeta GmbH', 'Alpha Ltd', 'Tier Three', 'Gone', 'Marked Co', 'Black Co', 'Tracked Co', 'Roche', 'Pistor', 'adesso Schweiz',
].map((company) => ({ company, status: 'En attente' }));

function rankSandbox() {
  const root = sandbox({
    rows: RANK_RADAR,
    tracker: trackerRow(3, 'Tracked Co SA') + trackerRow(4, 'Roche'),
    blacklist: '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Black Co | 2026-01-01 | company | test |\n',
  });
  ingest(root, PAGE);
  return root;
}

test('rank excludes tracked, blacklisted, marked and tier out rows, each counted', () => {
  const root = rankSandbox();
  const out = JSON.parse(run(root, ['rank', '--count', '10']).stdout);
  assert.deepEqual(out.excluded, { tracked: 2, blacklisted: 1, marked: 1, out: 1 });
  assert.equal(out.eligible, 5);
});

test('rank orders tier 1, 2, 3 then unmatched, ties by name; default count is 2', () => {
  const root = rankSandbox();
  const all = JSON.parse(run(root, ['rank', '--count', '10']).stdout);
  assert.deepEqual(all.picks.map((p) => p.company), ['adesso Schweiz', 'Pistor', 'Tier Three', 'Alpha Ltd', 'Zeta GmbH']);
  assert.deepEqual(all.picks.map((p) => p.tier), ['1', '2', '3', null, null]);
  const two = JSON.parse(run(root, ['rank']).stdout);
  assert.deepEqual(two.picks.map((p) => p.company), ['adesso Schweiz', 'Pistor']);
  assert.equal(two.picks[0].deleteRow, 'adesso Schweiz');
  assert.equal(two.picks[0].radar_key, 'adesso schweiz');
});

test('rank --summary tells the candidate which row to delete, and rank writes nothing', () => {
  const root = rankSandbox();
  const before = sha(pendingFile(root));
  const r = run(root, ['rank', '--summary']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /after you send it, delete the row "adesso Schweiz" in Candiboost/);
  assert.match(r.stdout, /after you send it, delete the row "Pistor" in Candiboost/);
  assert.equal(sha(pendingFile(root)), before);
});

test('rank without an ingested list exits 1 and creates nothing', () => {
  const root = sandbox();
  const r = run(root, ['rank']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ingest/);
  assert.equal(existsSync(pendingFile(root)), false);
});
