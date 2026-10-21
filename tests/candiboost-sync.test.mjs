import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RADAR_COLUMNS, serializeRegistry } from '../radar/registry.mjs';
import { GmailError, fetchSentThreads } from '../candiboost-sync.mjs';

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

function listTree(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = path.slice(base.length + 1);
    if (statSync(path).isDirectory()) { out.push(`${rel}/`); out.push(...listTree(path, base)); }
    else out.push(`${rel}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  }
  return out;
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
