import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, parseRegistry, serializeRegistry } from '../radar/registry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const prospect = (over) => ({
  ...Object.fromEntries(RADAR_COLUMNS.map((c) => [c, ''])),
  country: 'FR', size_band: '10-19', signals: '1', sector: '62.01Z', sources: 'sirene', sites: 'Colmar:A',
  first_seen: '2026-10-18', last_seen: '2026-10-18', portals_ref: '—', tier: '1', tier_reason: 'tier 1: zone A, FR, 1 signal', ...over,
});

const TRACKER_HEAD = '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
const trackerRow = (num, company) => `| ${num} | 2026-10-01 | ${company} | — | Dev | 4.0/5 | Applied | ✅ | — | n | |\n`;

function sandbox({ rows, tracker = null, blacklist = null, contacts = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'spontaneous-pick-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'radar.tsv'), serializeRegistry({ columns: [...RADAR_COLUMNS], rows }));
  if (tracker !== null) writeFileSync(join(dir, 'data', 'applications.md'), TRACKER_HEAD + tracker);
  if (blacklist) writeFileSync(join(dir, 'data', 'blacklist.md'), blacklist);
  if (contacts) writeFileSync(join(dir, 'data', 'contacts.tsv'), contacts);
  return dir;
}

function pick(root, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'spontaneous-pick.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}
const file = (root) => join(root, 'data', 'radar.tsv');
const sha = (root) => createHash('sha256').update(readFileSync(file(root))).digest('hex');
const readRows = (root) => parseRegistry(readFileSync(file(root), 'utf-8')).rows;
const byKey = (rows, k) => rows.find((p) => p['key'] === k);
const keys = (r) => JSON.parse(r.stdout).picks.map((p) => p.key);

const FOUR = [
  prospect({ key: 'a1', name: 'A One', signals: '1' }),
  prospect({ key: 'a2', name: 'A Two', signals: '2' }),
  prospect({ key: 'b1', name: 'B One', sites: 'Basel:B', country: 'CH' }),
  prospect({ key: 'd1', name: 'D One', sites: 'Zug:D', country: 'CH' }),
];

test('next returns at most 3 picks in rule order and never writes', () => {
  const root = sandbox({ rows: FOUR });
  const before = sha(root);
  const r = pick(root, ['next']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(keys(r), ['a2', 'a1', 'b1']);
  assert.equal(JSON.parse(r.stdout).eligible, 4);
  assert.equal(sha(root), before);
});

test('--count is honoured and clamped to 1-10', () => {
  const root = sandbox({ rows: FOUR });
  assert.equal(keys(pick(root, ['next', '--count', '1'])).length, 1);
  assert.equal(keys(pick(root, ['next', '--count', '99'])).length, 4);
  assert.equal(pick(root, ['next', '--count', '0']).status, 1);
});

test('tier 2 appears only when fewer tier 1 rows are eligible', () => {
  const rows = [
    prospect({ key: 't1', name: 'T One' }),
    prospect({ key: 't2a', name: 'T Two A', tier: '2', signals: '0' }),
    prospect({ key: 't2b', name: 'T Two B', tier: '2', signals: '0' }),
    prospect({ key: 'gone', name: 'Gone', tier: 'out' }),
    prospect({ key: 'three', name: 'Three', tier: '3' }),
  ];
  const root = sandbox({ rows });
  assert.deepEqual(keys(pick(root, ['next'])), ['t1', 't2a', 't2b']);
});

test('marked, tracked and blacklisted Prospects are excluded and counted', () => {
  const rows = [
    prospect({ key: 'm', name: 'Marked', spontaneous: 'drafted:2026-10-20' }),
    prospect({ key: 'skipped', name: 'Skipped', spontaneous: 'skipped:2026-10-20:no info' }),
    prospect({ key: 'acme', name: 'Acme' }),
    prospect({ key: 'beta inc', name: 'Beta Inc' }),
    prospect({ key: 'black', name: 'Black Co' }),
    prospect({ key: 'free', name: 'Free' }),
  ];
  const root = sandbox({
    rows,
    tracker: trackerRow(7, 'ACME SAS') + trackerRow(8, 'Beta Inc.'),
    blacklist: '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Black Co | 2026-01-01 | company | test |\n',
  });
  const out = JSON.parse(pick(root, ['next']).stdout);
  assert.deepEqual(out.picks.map((p) => p.key), ['free']);
  assert.deepEqual(out.excluded, { marked: 2, tracked: 2, blacklisted: 1 });
});

test('saved contacts are counted per Prospect and a missing contacts file counts 0', () => {
  const root = sandbox({
    rows: [prospect({ key: 'acme', name: 'Acme' })],
    contacts: 'Jane Doe\tAcme\trecruiter\tTA\t\t\t\t-\tmet\n',
  });
  assert.equal(JSON.parse(pick(root, ['next']).stdout).picks[0].savedContacts, 1);
  const none = sandbox({ rows: [prospect({ key: 'acme', name: 'Acme' })] });
  assert.equal(JSON.parse(pick(none, ['next']).stdout).picks[0].savedContacts, 0);
});

test('untiered and stale tiers are reported, and --summary says how to repair them', () => {
  const rows = [
    prospect({ key: 'fresh', name: 'Fresh', tier: '', tier_reason: '' }),
    prospect({ key: 'stale', name: 'Stale', tier: '2', tier_reason: 'old' }),
    prospect({ key: 'ok', name: 'Ok' }),
  ];
  const root = sandbox({ rows });
  const out = JSON.parse(pick(root, ['next']).stdout);
  assert.equal(out.untiered, 1);
  assert.equal(out.staleTiers, 1);
  assert.match(pick(root, ['next', '--summary']).stdout, /radar-tiers\.mjs --write/);
});

test('a pick that is pending in Candiboost is flagged with the row to delete', () => {
  const root = sandbox({ rows: FOUR });
  writeFileSync(
    join(root, 'data', 'candiboost-pending.tsv'),
    'company\tradar_key\tfirst_seen\tlast_seen\nA One SA\ta1\t2026-10-20\t2026-10-21\nB One\t\t2026-10-20\t2026-10-21\n',
  );
  const out = JSON.parse(pick(root, ['next']).stdout);
  const flags = Object.fromEntries(out.picks.map((p) => [p.key, [p.candiboostPending, p.candiboostRow]]));
  assert.deepEqual(flags, { a2: [false, null], a1: [true, 'A One SA'], b1: [true, 'B One'] });
  assert.match(
    pick(root, ['next', '--summary']).stdout,
    /pending in Candiboost: delete row "A One SA" after sending/,
  );
});

test('without a Candiboost pending list no pick is flagged', () => {
  const root = sandbox({ rows: FOUR });
  const out = JSON.parse(pick(root, ['next']).stdout);
  assert.ok(out.picks.every((p) => p.candiboostPending === false && p.candiboostRow === null));
  assert.doesNotMatch(pick(root, ['next', '--summary']).stdout, /pending in Candiboost/);
});

// ---- marks ------------------------------------------------------------------

const MARKABLE = [prospect({ key: 'acme', name: 'Acme', notes: 'keep' }), prospect({ key: 'beta', name: 'Beta', tier_override: '1' })];

test('mark drafted writes one cell and leaves every other cell and row identical', () => {
  const root = sandbox({ rows: MARKABLE });
  const before = readRows(root);
  const r = pick(root, ['mark', 'acme', 'drafted']);
  assert.equal(r.status, 0, r.stderr);
  const after = readRows(root);
  assert.match(byKey(after, 'acme').spontaneous, /^drafted:\d{4}-\d{2}-\d{2}$/);
  for (const row of before) {
    for (const c of RADAR_COLUMNS) {
      if (row['key'] === 'acme' && c === 'spontaneous') continue;
      assert.equal(byKey(after, row['key'])[c], row[c], `${row['key']}.${c}`);
    }
  }
});

test('mark skipped keeps the reason, and a key with a space works when quoted', () => {
  const root = sandbox({ rows: [prospect({ key: 'open systems', name: 'Open Systems' })] });
  const r = pick(root, ['mark', 'open systems', 'skipped', '--reason', 'no public info']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readRows(root)[0].spontaneous, /^skipped:\d{4}-\d{2}-\d{2}:no public info$/);
});

test('mark sent needs --tracker, a real row, and the same company', () => {
  const root = sandbox({ rows: MARKABLE, tracker: trackerRow(7, 'Acme SAS') + trackerRow(9, 'Other Co') });
  assert.equal(pick(root, ['mark', 'acme', 'sent']).status, 1);
  assert.equal(pick(root, ['mark', 'acme', 'sent', '--tracker', '999']).status, 2);
  assert.equal(pick(root, ['mark', 'acme', 'sent', '--tracker', '9']).status, 2);
  assert.equal(readRows(root)[0].spontaneous, '');
  const ok = pick(root, ['mark', 'acme', 'sent', '--tracker', '7']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readRows(root)[0].spontaneous, /^sent:\d{4}-\d{2}-\d{2}:#7$/);
});

test('transitions: sent is final, skipped cannot become sent, an unknown key exits 2', () => {
  const root = sandbox({ rows: MARKABLE, tracker: trackerRow(7, 'Acme') });
  assert.equal(pick(root, ['mark', 'acme', 'sent', '--tracker', '7']).status, 0);
  const sentCell = readRows(root)[0].spontaneous;
  assert.equal(pick(root, ['mark', 'acme', 'sent', '--tracker', '7']).status, 3);
  assert.equal(pick(root, ['mark', 'acme', 'drafted']).status, 3);
  assert.equal(readRows(root)[0].spontaneous, sentCell);

  const skip = sandbox({ rows: MARKABLE, tracker: trackerRow(7, 'Beta') });
  assert.equal(pick(skip, ['mark', 'beta', 'skipped']).status, 0);
  assert.equal(pick(skip, ['mark', 'beta', 'sent', '--tracker', '7']).status, 3);
  assert.equal(pick(skip, ['mark', 'nope', 'drafted']).status, 2);
});

test('a mark that fails leaves the registry byte-identical', () => {
  const root = sandbox({ rows: MARKABLE });
  const before = sha(root);
  pick(root, ['mark', 'acme', 'sent', '--tracker', '999']);
  pick(root, ['mark', 'nope', 'drafted']);
  assert.equal(sha(root), before);
});

test('--help prints usage', () => {
  const root = sandbox({ rows: MARKABLE });
  const r = pick(root, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node spontaneous-pick\.mjs/);
});
