import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, serializeRegistry } from '../radar/registry.mjs';
import { PENDING_COLUMNS, RESOLVED_COLUMNS, parseTable, serializeTable } from '../lib/candiboost.mjs';

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

test('ingest stores the domain lower-cased and \'\' when absent or malformed', () => {
  const root = sandbox();
  ingest(root, [
    { company: 'A', domain: 'HTTPS://WWW.Acme.CH/jobs', status: 'En attente' },
    { company: 'B', status: 'En attente' },
    { company: 'C', domain: 'not a domain', status: 'En attente' },
    { company: 'D', domain: 'localhost', status: 'En attente' },
  ]);
  assert.deepEqual(readPending(root).map((x) => x.domain), ['acme.ch', '', '', '']);
});

test('ingest upgrades a table written without the domain column', () => {
  const root = sandbox();
  writeFileSync(pendingFile(root), 'company\tradar_key\tfirst_seen\tlast_seen\nAcme AG\t\t2026-01-05\t2026-01-05\n');
  const r = ingest(root, [{ company: 'Acme AG', domain: 'acme.ch', status: 'En attente' }]);
  assert.equal(r.status, 0, r.stderr);
  const head = readFileSync(pendingFile(root), 'utf-8').split('\n')[0].split('\t');
  assert.ok(head.includes('domain'));
  const rows = readPending(root);
  assert.equal(rows[0].domain, 'acme.ch');
  assert.equal(rows[0].first_seen, '2026-01-05');
});

test('ingest matches a Prospect by the domain label', () => {
  const root = sandbox({ rows: RADAR });
  ingest(root, [{ company: 'Konditorei Holding', domain: 'www.pistor.ch', status: 'En attente' }]);
  assert.equal(readPending(root)[0].radar_key, 'pistor');
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
  prospect({ key: 'gone', name: 'Gone', tier: 'out', tier_reason: 'out: blacklisted' }),
  prospect({ key: 'tier three', name: 'Tier Three', tier: '3', tier_reason: 'tier 3: zone D' }),
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
  assert.equal(out.eligible, 2);
});

test('rank picks tier 1 then tier 2 only, ties by name; default count is 2', () => {
  const root = rankSandbox();
  const all = JSON.parse(run(root, ['rank', '--count', '10']).stdout);
  assert.deepEqual(all.picks.map((p) => p.company), ['adesso Schweiz', 'Pistor']);
  assert.deepEqual(all.picks.map((p) => p.tier), ['1', '2']);
  const two = JSON.parse(run(root, ['rank']).stdout);
  assert.deepEqual(two.picks.map((p) => p.company), ['adesso Schweiz', 'Pistor']);
  assert.equal(two.picks[0].deleteRow, 'adesso Schweiz');
  assert.equal(two.picks[0].radar_key, 'adesso schweiz');
});

test('rank lists tier out, tier 3, unmatched and untiered rows under notWorkable, sorted by company', () => {
  const root = rankSandbox();
  const out = JSON.parse(run(root, ['rank', '--count', '10']).stdout);
  assert.deepEqual(out.notWorkable, [
    { company: 'Alpha Ltd', reason: 'no resolution yet' },
    { company: 'Gone', reason: 'out: blacklisted' },
    { company: 'Tier Three', reason: 'tier 3: zone D' },
    { company: 'Zeta GmbH', reason: 'no resolution yet' },
  ]);
});

test('notWorkable gives the resolution verdict for an unmatched row and says when a tier is missing', () => {
  const root = sandbox({
    rows: [prospect({ key: 'fresh co', name: 'Fresh Co', tier: '' })],
  });
  writeFileSync(join(root, 'data', 'candiboost-resolved.tsv'), serializeTable({
    columns: [...RESOLVED_COLUMNS],
    rows: [
      { company: 'Biel Co', verdict: 'out-of-zone', candidates: 'Biel AG @ Biel (2502) #uid:CHE1;Biel SA @ Bern (3000) #uid:CHE2;Biel GmbH @ Biel (2503) #uid:CHE3;Biel Ltd @ Sion (1950) #uid:CHE4' },
      { company: 'Twin Co', verdict: 'ambiguous', candidates: '' },
      { company: 'Lost Co', verdict: 'unresolved', candidates: '' },
      { company: 'Folded Co', verdict: 'resolved', candidates: '' },
      { company: 'Hand Co', verdict: 'hand', candidates: '' },
    ],
  }));
  ingest(root, ['Fresh Co', 'Biel Co', 'Twin Co', 'Lost Co', 'Folded Co', 'Hand Co', 'Unknown Co'].map((company) => ({ company, status: 'En attente' })));
  const out = JSON.parse(run(root, ['rank']).stdout);
  assert.deepEqual(out.picks, []);
  const reasons = Object.fromEntries(out.notWorkable.map((x) => [x.company, x.reason]));
  assert.equal(reasons['Fresh Co'], 'no tier yet: run node radar-tiers.mjs --write');
  assert.equal(reasons['Biel Co'], 'out-of-zone: Biel, Bern, Sion');
  assert.equal(reasons['Twin Co'], 'ambiguous: fill entity_id in data/candiboost-resolved.tsv');
  assert.equal(reasons['Lost Co'], 'unresolved');
  assert.equal(reasons['Folded Co'], 'resolved, not in the Radar yet: run radar.mjs --source candiboost --write, then rematch');
  assert.equal(reasons['Hand Co'], 'resolved, not in the Radar yet: run radar.mjs --source candiboost --write, then rematch');
  assert.equal(reasons['Unknown Co'], 'no resolution yet');
});

test('rank --summary tells the candidate which row to delete, and rank writes nothing', () => {
  const root = rankSandbox();
  const before = sha(pendingFile(root));
  const r = run(root, ['rank', '--summary']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /after you send it, delete the row "adesso Schweiz" in Candiboost/);
  assert.match(r.stdout, /after you send it, delete the row "Pistor" in Candiboost/);
  assert.match(r.stdout, /not workable: \d+/);
  assert.match(r.stdout, /  - Gone: out: blacklisted/);
  assert.equal(sha(pendingFile(root)), before);
});

test('rank without an ingested list exits 1 and creates nothing', () => {
  const root = sandbox();
  const r = run(root, ['rank']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ingest/);
  assert.equal(existsSync(pendingFile(root)), false);
});

// ---- rematch ----------------------------------------------------------------

test('rematch fills an empty radar_key through a Prospect alias', () => {
  const root = sandbox({ rows: RADAR });
  ingest(root, [{ company: 'Pistor Spelling', status: 'En attente' }, { company: 'Nobody', status: 'En attente' }]);
  assert.deepEqual(readPending(root).map((x) => x.radar_key), ['', '']);
  const radarPath = join(root, 'data', 'radar.tsv');
  writeFileSync(radarPath, serializeRegistry({
    columns: [...RADAR_COLUMNS],
    rows: [RADAR[0], { ...RADAR[1], aliases: 'Pistor Spelling' }],
  }));
  const r = run(root, ['rematch']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { matched: 1, unmatched: 1, changed: 1 });
  assert.deepEqual(readPending(root).map((x) => x.radar_key), ['pistor', '']);
});

test('rematch never clears a key and a second run reports changed 0', () => {
  const root = sandbox({ rows: RADAR });
  ingest(root, [{ company: 'adesso Schweiz', status: 'En attente' }]);
  writeFileSync(join(root, 'data', 'radar.tsv'), serializeRegistry({ columns: [...RADAR_COLUMNS], rows: [] }));
  const first = JSON.parse(run(root, ['rematch']).stdout);
  assert.deepEqual(first, { matched: 0, unmatched: 1, changed: 0 });
  assert.equal(readPending(root)[0].radar_key, 'adesso schweiz');
  writeFileSync(join(root, 'data', 'radar.tsv'), serializeRegistry({
    columns: [...RADAR_COLUMNS],
    rows: [prospect({ key: 'adesso schweiz', name: 'adesso Schweiz' }), prospect({ key: 'adesso schweiz|CH|basel', name: 'adesso Schweiz' })],
  }));
  assert.equal(JSON.parse(run(root, ['rematch']).stdout).changed, 0);
  assert.equal(readPending(root)[0].radar_key, 'adesso schweiz');
});

test('rematch rewrites a stale key when the match is definite and different', () => {
  const root = sandbox({ rows: RADAR });
  ingest(root, [{ company: 'Pistor', status: 'En attente' }]);
  const text = readFileSync(pendingFile(root), 'utf-8').replace('\tpistor\t', '\told key\t');
  writeFileSync(pendingFile(root), text);
  assert.deepEqual(JSON.parse(run(root, ['rematch']).stdout), { matched: 1, unmatched: 0, changed: 1 });
  assert.equal(readPending(root)[0].radar_key, 'pistor');
  assert.equal(JSON.parse(run(root, ['rematch']).stdout).changed, 0);
});

test('rematch without a list exits 1 and creates nothing', () => {
  const root = sandbox();
  const r = run(root, ['rematch']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ingest/);
  assert.equal(existsSync(pendingFile(root)), false);
});

test('--help names rematch', () => {
  assert.match(run(sandbox(), ['--help']).stdout, /rematch/);
});
