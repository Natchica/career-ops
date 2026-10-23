import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resettleRows, retryRows } from '../candiboost-resolve.mjs';
import { formatCandidates } from '../radar/resolve.mjs';
import { loadZoneTable } from '../radar/zones.mjs';
import { RESOLVED_COLUMNS, parseTable, serializeTable } from '../lib/candiboost.mjs';
import { localToday } from '../lib/local-today.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'candiboost-resolve-zones-')), codeRoot: ROOT });

const row = (over = {}) => ({
  company: 'X', domain: '', country: '', legal_name: '', entity_id: '', place: '', postcode: '', sector: '',
  size_band: '', verdict: 'unresolved', candidates: '', checked: '2026-10-20', ...over,
});
const cand = (legalName, place, postcode, entityId) => ({ legalName, sites: [{ place, postcode }], entityId });

const helbling = () => row({
  company: 'helbling technik',
  verdict: 'ambiguous',
  candidates: formatCandidates([
    cand('Helbling Technik AG', 'Zürich', '8005', 'uid:CHE200000002'),
    cand('Helbling Technik AG', 'Zürich', '8005', 'uid:CHE200000001'),
  ]),
});
const blkb = () => row({
  company: 'BLKB',
  verdict: 'ambiguous',
  candidates: formatCandidates([
    cand('BLKB Stiftung', 'Basel', '4051', 'uid:CHE300000001'),
    cand('BLKB Holding AG', 'Zürich', '8005', 'uid:CHE300000002'),
  ]),
});
const resolved = () => row({ company: 'Done', country: 'CH', legal_name: 'Done AG', entity_id: 'uid:CHE400000001', place: 'Basel', postcode: '4051', size_band: '?', verdict: 'resolved' });

test('resettleRows settles a brand with several entities and keeps its candidates', () => {
  const src = helbling();
  const out = resettleRows([src], { table, today: '2026-10-23' });
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0], {
    ...src, country: 'CH', legal_name: 'Helbling Technik AG', entity_id: 'uid:CHE200000001', place: 'Zürich', postcode: '8005',
    sector: '', size_band: '?', verdict: 'resolved', checked: '2026-10-23',
  });
  assert.deepEqual(out.picks, [{ company: 'helbling technik', legalName: 'Helbling Technik AG', place: 'Zürich', capped: false }]);
  assert.equal(out.stillAmbiguous, 0);
});

test('resettleRows leaves a row of non-operating entities ambiguous', () => {
  const src = blkb();
  const out = resettleRows([src], { table, today: '2026-10-23' });
  assert.deepEqual(out.rows, [src]);
  assert.equal(out.rows[0], src);
  assert.equal(out.stillAmbiguous, 1);
  assert.deepEqual(out.picks, []);
});

test('resettleRows skips a row whose candidates do not parse or whose spelling has no needle', () => {
  const garbled = row({ company: 'Foo', verdict: 'ambiguous', candidates: 'not a candidate' });
  const short = row({ company: 'ab', verdict: 'ambiguous', candidates: helbling().candidates });
  const out = resettleRows([garbled, short], { table, today: '2026-10-23' });
  assert.deepEqual(out.rows, [garbled, short]);
  assert.deepEqual(out.skipped, ['Foo', 'ab']);
});

test('resettleRows counts a hand-edited ambiguous row and keeps it', () => {
  const edited = { ...helbling(), entity_id: 'uid:CHE200000002' };
  const placed = { ...helbling(), company: 'helbling', place: 'Zug' };
  const out = resettleRows([edited, placed], { table, today: '2026-10-23' });
  assert.deepEqual(out.rows, [edited, placed]);
  assert.equal(out.handEdits, 2);
  assert.deepEqual(out.picks, []);
});

test('resettleRows leaves every other verdict untouched', () => {
  const rows = [resolved(), row({ company: 'Gone' }), row({ company: 'Away', verdict: 'out-of-zone', candidates: helbling().candidates })];
  const out = resettleRows(rows, { table, today: '2026-10-23' });
  assert.deepEqual(out.rows, rows);
  rows.forEach((r, i) => assert.equal(out.rows[i], r));
});

test('resettleRows marks a pick drawn from a capped candidate list', () => {
  const many = Array.from({ length: 21 }, (_, i) => cand('Helbling Technik AG', 'Zürich', '8005', `uid:CHE2000000${String(i).padStart(2, '0')}`));
  const out = resettleRows([row({ company: 'helbling technik', verdict: 'ambiguous', candidates: formatCandidates(many) })], { table, today: '2026-10-23' });
  assert.equal(out.picks[0].capped, true);
});

test('retryRows deletes unresolved rows and keeps hand-edited ones', () => {
  const keep = row({ company: 'Kanton', place: 'Zug' });
  const keepId = row({ company: 'Id', entity_id: 'uid:CHE1' });
  const rows = [row({ company: 'Gone' }), resolved(), keep, keepId, blkb()];
  const out = retryRows(rows);
  assert.deepEqual(out.rows, [resolved(), keep, keepId, blkb()]);
  assert.equal(out.deleted, 1);
  assert.equal(out.keptHandEdits, 2);
});

function sandbox(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'candiboost-resolve-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  if (rows) writeFileSync(file(dir), serializeTable({ columns: [...RESOLVED_COLUMNS], rows }));
  return dir;
}
const file = (root) => join(root, 'data', 'candiboost-resolved.tsv');
const readRows = (root) => parseTable(readFileSync(file(root), 'utf-8'), { key: 'company', columns: RESOLVED_COLUMNS }).rows;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function run(root, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'candiboost-resolve.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}

const MIXED = () => [resolved(), helbling(), blkb(), row({ company: 'Gone' })];

test('resettle --dry-run reports the picks and leaves the file byte-identical', () => {
  const root = sandbox(MIXED());
  const digest = sha(file(root));
  const r = run(root, ['resettle', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  const [first, ...lines] = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(first), { resettled: 1, stillAmbiguous: 1, handEdits: 0, skipped: 0, written: false });
  assert.deepEqual(lines, ['  helbling technik → Helbling Technik AG @ Zürich']);
  assert.equal(sha(file(root)), digest);
});

test('resettle writes only the settled rows', () => {
  const root = sandbox(MIXED());
  const before = readRows(root);
  const r = run(root, ['resettle']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.split('\n')[0]).written, true);
  const after = readRows(root);
  assert.deepEqual(after.map((x) => x.company), before.map((x) => x.company));
  assert.equal(after[1].verdict, 'resolved');
  assert.equal(after[1].entity_id, 'uid:CHE200000001');
  assert.deepEqual([after[0], after[2], after[3]], [before[0], before[2], before[3]]);
});

test('resettle with nothing to settle writes nothing', () => {
  const root = sandbox([resolved(), blkb()]);
  const digest = sha(file(root));
  const r = run(root, ['resettle']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.split('\n')[0]), { resettled: 0, stillAmbiguous: 1, handEdits: 0, skipped: 0, written: false });
  assert.equal(sha(file(root)), digest);
});

test('resettle on a missing or malformed file exits 1 and writes nothing', () => {
  const missing = sandbox();
  const r = run(missing, ['resettle']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no resolution table/);
  assert.equal(existsSync(file(missing)), false);

  const bad = sandbox();
  const line = RESOLVED_COLUMNS.map((c) => (c === 'company' ? 'Foo' : '')).join('\t');
  writeFileSync(file(bad), `${RESOLVED_COLUMNS.join('\t')}\n${line}\n${line}\n`);
  const digest = sha(file(bad));
  const r2 = run(bad, ['resettle']);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /duplicate company/);
  assert.equal(sha(file(bad)), digest);
});

const backupDir = (root) => join(root, 'data', `backup-${localToday()}-retry`);

test('retry --dry-run writes nothing', () => {
  const root = sandbox(MIXED());
  const digest = sha(file(root));
  const r = run(root, ['retry', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { deleted: 1, keptHandEdits: 0, backup: null, dryRun: true });
  assert.equal(sha(file(root)), digest);
  assert.equal(existsSync(backupDir(root)), false);
});

test('retry backs the file up, then deletes only unresolved rows', () => {
  const kept = row({ company: 'Kanton', place: 'Zug' });
  const root = sandbox([...MIXED(), kept]);
  const digest = sha(file(root));
  const r = run(root, ['retry']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { deleted: 1, keptHandEdits: 1, backup: `data/backup-${localToday()}-retry/candiboost-resolved.tsv` });
  assert.equal(sha(join(backupDir(root), 'candiboost-resolved.tsv')), digest);
  assert.deepEqual(readRows(root).map((x) => x.company), ['Done', 'helbling technik', 'BLKB', 'Kanton']);
});

test('retry with nothing to delete writes no backup', () => {
  const root = sandbox([resolved(), blkb()]);
  const digest = sha(file(root));
  const r = run(root, ['retry']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { deleted: 0, keptHandEdits: 0, backup: null });
  assert.equal(sha(file(root)), digest);
  assert.equal(existsSync(backupDir(root)), false);
});

test('retry refuses to overwrite a backup of the same day', () => {
  const root = sandbox(MIXED());
  mkdirSync(backupDir(root), { recursive: true });
  writeFileSync(join(backupDir(root), 'candiboost-resolved.tsv'), 'old\n');
  const digest = sha(file(root));
  const r = run(root, ['retry']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /backup exists/);
  assert.equal(sha(file(root)), digest);
  assert.equal(readFileSync(join(backupDir(root), 'candiboost-resolved.tsv'), 'utf-8'), 'old\n');
});

test('--help exits 0 and an unknown command exits 1', () => {
  const root = sandbox();
  const help = run(root, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node candiboost-resolve\.mjs/);
  const bad = run(root, ['nonsense']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /first argument must be resettle or retry/);
});
