import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, serializeRegistry } from '../radar/registry.mjs';
import { GmailError, fetchSentThreads, rankFollowups, reserveInChunks } from '../candiboost-sync.mjs';
import { REGISTRY_COLUMNS, readTable } from '../lib/candiboost.mjs';
import { parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';
import { listTree as walkFiles } from '../lib/walk-tree.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'candiboost', 'threads.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const prospect = (over) => ({
  ...Object.fromEntries(RADAR_COLUMNS.map((c) => [c, ''])),
  country: 'CH', size_band: '50-99', signals: '1', sector: '62.01Z', sources: 'zefix', sites: 'Zurich:D',
  first_seen: '2026-10-18', last_seen: '2026-10-18', portals_ref: '—', ...over,
});
const RADAR = [
  prospect({ key: 'adesso schweiz', name: 'adesso Schweiz', tier: '1', tier_reason: 'tier 1: test' }),
  prospect({ key: 'adesso insurance solutions schweiz', name: 'adesso insurance solutions Schweiz', tier: '2', tier_reason: 'tier 2: test' }),
  prospect({ key: 'pistor', name: 'Pistor', tier: '2', tier_reason: 'tier 2: test' }),
];
const TRACKER_HEAD = '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
const ROCHE = '| 1 | 2026-09-01 | Roche | — | Backend Engineer | 4.0/5 | Applied | ✅ | — | n | |\n';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'candiboost-sync-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'radar.tsv'), serializeRegistry({ columns: [...RADAR_COLUMNS], rows: RADAR }));
  writeFileSync(join(dir, 'data', 'applications.md'), TRACKER_HEAD + ROCHE);
  return dir;
}

function listTree(dir) {
  return walkFiles(dir)
    .map((path) => `${path.slice(dir.length + 1)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
    .sort();
}

function sync(root, args, envOver = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'candiboost-sync.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', timeout: 120_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '', ...envOver },
  });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}

const ENV = { GMAIL_CLIENT_ID: 'cid-123', GMAIL_CLIENT_SECRET: 'sec-456', GMAIL_REFRESH_TOKEN: 'ref-789' };
const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

function fakeGmail({ tokenReply, listReply } = {}) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return tokenReply ?? reply({ access_token: 'at-1' });
    if (String(url).includes('/threads?')) {
      if (listReply) return listReply;
      return String(url).includes('pageToken=p2')
        ? reply({ threads: [{ id: 'cb0003' }, { id: 'cb0004' }] })
        : reply({ threads: [{ id: 'cb0001' }, { id: 'cb0002' }], nextPageToken: 'p2' });
    }
    const id = String(url).match(/\/threads\/([^?]+)\?format=full/)?.[1];
    return reply(FIXTURE.find((t) => t.id === id));
  };
  return { fetch, urls };
}

test('fetchSentThreads pages the list, then gets each thread in full', async () => {
  const { fetch, urls } = fakeGmail();
  const threads = await fetchSentThreads({ fetch, env: ENV });
  assert.deepEqual(threads.map((t) => t.id), ['cb0001', 'cb0002', 'cb0003', 'cb0004']);
  const list = urls.filter((u) => u.includes('/threads?'));
  assert.equal(list.length, 2);
  assert.ok(list[0].includes('q=in%3Asent%20subject%3A%22Candidature%20spontan%C3%A9e%22'), list[0]);
  assert.ok(urls.some((u) => u.endsWith('/threads/cb0004?format=full')));
});

test('an expired grant becomes a GmailError that carries Google text and no env value', async () => {
  const { fetch } = fakeGmail({ tokenReply: reply({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { ok: false, status: 400 }) });
  await assert.rejects(fetchSentThreads({ fetch, env: ENV }), (e) => {
    assert.ok(e instanceof GmailError);
    assert.match(e.message, /invalid_grant/);
    assert.match(e.message, /Token has been expired or revoked\./);
    for (const v of Object.values(ENV)) assert.ok(!e.message.includes(v), `message leaks ${v}`);
    return true;
  });
});

test('a scope failure on threads.list is reported with its Google text', async () => {
  const { fetch } = fakeGmail({ listReply: reply({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } }, { ok: false, status: 403 }) });
  await assert.rejects(fetchSentThreads({ fetch, env: ENV }), (e) => {
    assert.ok(e instanceof GmailError);
    assert.match(e.message, /PERMISSION_DENIED/);
    assert.match(e.message, /insufficient authentication scopes/);
    return true;
  });
});

test('--help lists the commands and flags', () => {
  const r = sync(sandbox(), ['--help']);
  assert.equal(r.status, 0, r.stderr);
  for (const word of ['sync', 'pick', 'mark', '--dry-run', '--summary', '--threads-file']) assert.ok(r.stdout.includes(word), word);
});

test('an unknown flag exits 1', () => {
  assert.equal(sync(sandbox(), ['sync', '--dryrun']).status, 1);
});

test('sync without a threads file and without Gmail env exits 1, names the variables and writes nothing', () => {
  const root = sandbox();
  const before = listTree(root);
  const r = sync(root, ['sync'], { GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '' });
  assert.equal(r.status, 1);
  for (const name of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) assert.ok(r.stderr.includes(name), name);
  assert.ok(r.stderr.includes('node --env-file=.env'));
  assert.deepEqual(listTree(root), before);
});

test('--dry-run reports the first-run plan and writes nothing', () => {
  const root = sandbox();
  const before = listTree(root);
  const r = sync(root, ['sync', '--dry-run', '--threads-file', FIXTURE_PATH]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.threads, 9);
  assert.equal(out.sends, 7);
  assert.deepEqual(out.skipped.map((s) => s.thread_id), ['cb0008', 'cb0009']);
  assert.equal(out.bounced, 1);
  assert.equal(out.replied, 1);
  assert.equal(out.new, 7);
  assert.equal(out.statusChanges, 0);
  assert.equal(out.newTrackerRows, 5);
  assert.deepEqual(out.radar, { matched: 2, unmatched: 5, ambiguous: 0 });
  assert.deepEqual(out.contacts, { new: 7, noName: 0 });
  assert.deepEqual(out.replyCandidates, { new: 1 });
  assert.deepEqual(out.alreadyTracked, [{ company: 'Roche', row: 1, command: 'node set-status.mjs --row 1 "Applied" --note "candiboost send 2026-10-16"' }]);
  assert.deepEqual(listTree(root), before);
  assert.ok(!existsSync(join(root, 'reports')));
  assert.ok(!existsSync(join(root, 'batch')));
  assert.ok(!existsSync(join(root, 'data', 'candiboost.tsv')));
});

test('--summary shows counts, company names and skipped ids, no address and no contact name', () => {
  const r = sync(sandbox(), ['sync', '--dry-run', '--summary', '--threads-file', FIXTURE_PATH]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /9 threads/);
  assert.match(r.stdout, /7 sends/);
  assert.ok(r.stdout.includes('cb0008') && r.stdout.includes('cb0009'));
  assert.ok(r.stdout.includes('Roche'));
  assert.ok(!r.stdout.includes('@'));
  for (const name of ['Huber', 'Weber', 'Keller', 'Meier', 'Brun', 'Frei', 'Morel']) assert.ok(!r.stdout.includes(name), name);
});

const trackerRows = (root) => {
  const lines = readFileSync(join(root, 'data', 'applications.md'), 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
};
const registryRows = (root) => readTable(join(root, 'data', 'candiboost.tsv'), { key: 'thread_id', columns: REGISTRY_COLUMNS }).rows;
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const ADDITIONS = (root) => join(root, 'batch', 'tracker-additions');

test('the first real run records sends in the tracker, phonebook, reply candidates and registry', () => {
  const root = sandbox();
  const r = sync(root, ['sync', '--threads-file', FIXTURE_PATH]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, false);
  assert.equal(out.new, 7);
  assert.deepEqual(out.mergeFailed, []);
  assert.equal(out.merged, 5);

  const rows = trackerRows(root);
  assert.deepEqual(rows.map((t) => t.num).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  const byNum = Object.fromEntries(rows.map((t) => [t.num, t]));
  assert.deepEqual([2, 3, 4, 5, 6].map((n) => byNum[n].company), ['BKB', 'ACME BANK', 'Pistor', 'adesso Schweiz', 'optimo-example.ch']);
  for (const n of [2, 3, 4, 5, 6]) {
    assert.equal(byNum[n].status, 'Applied');
    assert.equal(byNum[n].score, 'N/A');
    assert.equal(byNum[n].via, '—');
    assert.equal(byNum[n].role, 'Spontaneous application');
    assert.equal(byNum[n].notes, 'candiboost; contact type hiring contact');
  }
  assert.equal(byNum[1].status, 'Applied');
  assert.match(byNum[1].notes, /candiboost send 2026-10-16/);

  const merged = readdirSync(join(ADDITIONS(root), 'merged'));
  assert.equal(merged.length, 5);
  assert.deepEqual(readdirSync(ADDITIONS(root)).filter((f) => f.endsWith('.tsv')), []);
  assert.deepEqual(readdirSync(join(root, 'reports')).filter((f) => f.includes('RESERVED')), []);

  const contacts = readFileSync(join(root, 'data', 'contacts.tsv'), 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(contacts.length, 7);
  for (const line of contacts) {
    const cells = line.split('\t');
    assert.equal(cells.length, 9);
    assert.equal(cells[2], 'other');
    assert.match(cells[7], /^[2-6]$|^1$/);
  }
  assert.ok(contacts.some((l) => l.startsWith('Jean-Luc Morel\t')));

  const candidates = JSON.parse(readFileSync(join(root, 'data', 'reply-candidates.json'), 'utf-8'));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].message_id, 'cb0003r');
  assert.equal(candidates[0].signal, null);

  const reg = registryRows(root);
  assert.equal(reg.length, 7);
  const status = Object.fromEntries(reg.map((x) => [x.thread_id, x.status]));
  assert.equal(status.cb0002, 'bounced');
  assert.equal(status.cb0003, 'replied');
  assert.equal(status.cb0001, 'sent');
  assert.ok(reg.every((x) => x.tracker !== '' && x.followup === ''));
  const num = Object.fromEntries(reg.map((x) => [x.thread_id, x.tracker]));
  assert.equal(num.cb0001, num.cb0006);
  assert.equal(num.cb0005, '1');
  assert.equal(new Set(Object.values(num)).size, 6);
});

test('a second run writes nothing', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', FIXTURE_PATH]).status, 0);
  const files = ['data/applications.md', 'data/contacts.tsv', 'data/reply-candidates.json', 'data/candiboost.tsv'].map((f) => join(root, f));
  const before = files.map(hashOf);
  const r = sync(root, ['sync', '--threads-file', FIXTURE_PATH]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.new, 0);
  assert.equal(out.statusChanges, 0);
  assert.equal(out.newTrackerRows, 0);
  assert.deepEqual(files.map(hashOf), before);
});

test('a thread that gains a bounce changes only its registry status', () => {
  const root = sandbox();
  const early = FIXTURE.map((t) => (t.id === 'cb0002' ? { ...t, messages: t.messages.slice(0, 1) } : t));
  const earlyPath = join(root, 'early.json');
  writeFileSync(earlyPath, JSON.stringify(early));
  assert.equal(sync(root, ['sync', '--threads-file', earlyPath]).status, 0);
  assert.equal(registryRows(root).find((x) => x.thread_id === 'cb0002').status, 'sent');
  const files = ['data/applications.md', 'data/contacts.tsv', 'data/reply-candidates.json'].map((f) => join(root, f));
  const before = files.map(hashOf);
  const regBefore = registryRows(root);
  const r = sync(root, ['sync', '--threads-file', FIXTURE_PATH]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).statusChanges, 1);
  assert.deepEqual(files.map(hashOf), before);
  const regAfter = registryRows(root);
  assert.equal(regAfter.find((x) => x.thread_id === 'cb0002').status, 'bounced');
  assert.deepEqual(regAfter.filter((x) => x.thread_id !== 'cb0002'), regBefore.filter((x) => x.thread_id !== 'cb0002'));
});

test('a pending addition blocks the run and nothing is written', () => {
  const root = sandbox();
  mkdirSync(ADDITIONS(root), { recursive: true });
  writeFileSync(join(ADDITIONS(root), '999-x.tsv'), 'num\tdate\n');
  const before = listTree(root);
  const r = sync(root, ['sync', '--threads-file', FIXTURE_PATH]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('999-x.tsv'));
  assert.ok(r.stderr.includes('node merge-tracker.mjs'));
  assert.deepEqual(listTree(root), before);
});

const send = (over) => ({
  thread_id: 't', sent_at: '2026-10-10', domain: 'a.ch', company: 'A', radar_key: '', to_email: 'x@a.ch', contact_name: 'X',
  civility: 'M.', status: 'sent', tracker: '2', followup: '', ...over,
});
const rankOpts = (over = {}) => ({
  today: '2026-10-22', tierOf: () => '', trackerStatusOf: () => 'Applied', isBlacklisted: () => false, ...over,
});

test('rankFollowups keeps only due, unanswered, untouched Applied sends', () => {
  const rows = [
    send({ thread_id: 'ok' }),
    send({ thread_id: 'young', sent_at: '2026-10-16' }),
    send({ thread_id: 'edge', sent_at: '2026-10-15' }),
    send({ thread_id: 'bounced', status: 'bounced' }),
    send({ thread_id: 'replied', status: 'replied' }),
    send({ thread_id: 'done', followup: '2026-10-20' }),
    send({ thread_id: 'rejected', tracker: '9' }),
  ];
  const out = rankFollowups(rows, rankOpts({ trackerStatusOf: (r) => (r.tracker === '9' ? 'Rejected' : 'Applied') }));
  assert.deepEqual(out.picks.map((p) => p.thread_id), ['ok', 'edge']);
});

test('rankFollowups orders by tier, then older send, then domain', () => {
  const tiers = { k1: '1', k2: '2', k3: '3' };
  const rows = [
    send({ thread_id: 'un', domain: 'u.ch' }),
    send({ thread_id: 't3', radar_key: 'k3' }),
    send({ thread_id: 't2', radar_key: 'k2' }),
    send({ thread_id: 't1new', radar_key: 'k1', sent_at: '2026-10-12' }),
    send({ thread_id: 't1old', radar_key: 'k1', sent_at: '2026-10-08' }),
    send({ thread_id: 't1b', radar_key: 'k1', sent_at: '2026-10-08', domain: 'b.ch' }),
  ];
  const out = rankFollowups(rows, rankOpts({ tierOf: (r) => tiers[r.radar_key] ?? '', count: 2 }));
  assert.deepEqual(out.picks.map((p) => p.thread_id), ['t1old', 't1b']);
  const all = rankFollowups(rows, rankOpts({ tierOf: (r) => tiers[r.radar_key] ?? '', count: 99 }));
  assert.equal(all.picks.length, 2);
  const wide = (count) => rankFollowups(rows, rankOpts({ tierOf: (r) => tiers[r.radar_key] ?? '', count })).picks.map((p) => p.thread_id);
  assert.deepEqual(wide(0), ['t1old']);
  assert.deepEqual(wide(undefined), ['t1old', 't1b']);
});

test('rankFollowups drops tier out and blacklisted sends and counts them', () => {
  const rows = [
    send({ thread_id: 'out', radar_key: 'o' }),
    send({ thread_id: 'bl', company: 'Blocked' }),
    send({ thread_id: 'fine', domain: 'f.ch' }),
  ];
  const out = rankFollowups(rows, rankOpts({ tierOf: (r) => (r.radar_key === 'o' ? 'out' : ''), isBlacklisted: (r) => r.company === 'Blocked' }));
  assert.deepEqual(out.picks.map((p) => p.thread_id), ['fine']);
  assert.deepEqual(out.excluded, { out: 1, blacklisted: 1 });
});

function datedFixture(root, daysAgo) {
  const base = Date.now() - daysAgo * 86_400_000;
  const threads = FIXTURE.map((t) => ({
    ...t,
    messages: t.messages.map((m, i) => ({ ...m, internalDate: String(base + i * 3_600_000) })),
  }));
  const path = join(root, 'dated.json');
  writeFileSync(path, JSON.stringify(threads));
  return path;
}

test('pick lists the due follow-ups with their fields and writes nothing', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', datedFixture(root, 10)]).status, 0);
  const before = listTree(root);
  const r = sync(root, ['pick']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.picks.map((p) => p.thread_id), ['cb0004', 'cb0001']);
  const first = out.picks[0];
  assert.deepEqual(Object.keys(first).sort(), ['civility', 'company', 'contact_name', 'days', 'domain', 'gmail_url', 'radar_key', 'sent_at', 'thread_id', 'tier', 'tracker'].sort());
  assert.equal(first.tier, '1');
  assert.equal(first.days, 10);
  assert.equal(first.gmail_url, 'https://mail.google.com/mail/u/0/#all/cb0004');
  assert.equal(first.radar_key, 'adesso schweiz');
  assert.equal(first.contact_name, 'Lukas Meier');
  assert.deepEqual(listTree(root), before);
  assert.equal(JSON.parse(sync(root, ['pick', '--count', '1']).stdout).picks.length, 1);
  assert.equal(JSON.parse(sync(root, ['pick', '--count', '9']).stdout).picks.length, 2);
});

test('pick --domain shows the rows of one domain with a reason for each ineligible one', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', datedFixture(root, 10)]).status, 0);
  const bkb = JSON.parse(sync(root, ['pick', '--domain', 'bkb.ch']).stdout);
  assert.deepEqual(bkb.rows.map((x) => [x.thread_id, x.eligible]), [['cb0001', true], ['cb0006', true]]);
  const acme = JSON.parse(sync(root, ['pick', '--domain', 'acme-bank.com']).stdout);
  assert.equal(acme.rows[0].eligible, false);
  assert.match(acme.rows[0].reason, /bounced/);
  const none = sync(root, ['pick', '--domain', 'nowhere.example']);
  assert.equal(none.status, 0);
  assert.deepEqual(JSON.parse(none.stdout).rows, []);
});

test('pick --summary prints a line per pick', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', datedFixture(root, 10)]).status, 0);
  const r = sync(root, ['pick', '--summary']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /adesso Schweiz/);
  assert.match(r.stdout, /https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/cb0004/);
});

test('mark followed sets only the followup cell', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', FIXTURE_PATH]).status, 0);
  const before = registryRows(root);
  const r = sync(root, ['mark', 'cb0001', 'followed', '--date', '2026-10-25']);
  assert.equal(r.status, 0, r.stderr);
  const after = registryRows(root);
  assert.equal(after.find((x) => x.thread_id === 'cb0001').followup, '2026-10-25');
  assert.deepEqual(after.filter((x) => x.thread_id !== 'cb0001'), before.filter((x) => x.thread_id !== 'cb0001'));
  assert.deepEqual({ ...after.find((x) => x.thread_id === 'cb0001'), followup: '' }, before.find((x) => x.thread_id === 'cb0001'));

  const file = join(root, 'data', 'candiboost.tsv');
  const hash = hashOf(file);
  assert.equal(sync(root, ['mark', 'cb0001', 'followed', '--date', '2026-10-25']).status, 0);
  assert.equal(hashOf(file), hash);
  assert.equal(sync(root, ['mark', 'cb0001', 'followed', '--date', '2026-10-26']).status, 3);
  assert.equal(hashOf(file), hash);
});

test('mark followed without a date uses today', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', FIXTURE_PATH]).status, 0);
  assert.equal(sync(root, ['mark', 'cb0005', 'followed']).status, 0);
  assert.match(registryRows(root).find((x) => x.thread_id === 'cb0005').followup, /^\d{4}-\d{2}-\d{2}$/);
});

test('mark refuses an unknown thread, a bad date and a bad state', () => {
  const root = sandbox();
  assert.equal(sync(root, ['sync', '--threads-file', FIXTURE_PATH]).status, 0);
  assert.equal(sync(root, ['mark', 'nope', 'followed']).status, 2);
  assert.equal(sync(root, ['mark', 'cb0001', 'followed', '--date', '2026-13-40']).status, 1);
  assert.equal(sync(root, ['mark', 'cb0001', 'followed', '--date', 'tomorrow']).status, 1);
  assert.equal(sync(root, ['mark', 'cb0001', 'sent']).status, 1);
  assert.equal(sync(root, ['mark', 'cb0001']).status, 1);
});

test('reserveInChunks reserves at most 50 at a time and releases earlier chunks on failure', async () => {
  const calls = [];
  let next = 10;
  const reserveFn = async (n) => { calls.push(n); const out = Array.from({ length: n }, () => next++); return out; };
  const numbers = await reserveInChunks(120, reserveFn, async () => {});
  assert.deepEqual(calls, [50, 50, 20]);
  assert.equal(numbers.length, 120);
  assert.equal(new Set(numbers).size, 120);

  const released = [];
  let n = 0;
  const flaky = async (count) => { if (++n === 2) throw new Error('lock busy'); return Array.from({ length: count }, (_, i) => i + 1); };
  await assert.rejects(reserveInChunks(120, flaky, async (chunk) => released.push(chunk.length)), /lock busy/);
  assert.deepEqual(released, [50]);
});
