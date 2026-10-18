import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import source, { searchNames } from '../radar/sources/github-orgs.mjs';
import { loadZoneTable, zoneRecord } from '../radar/zones.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-gh-')), codeRoot: ROOT });
const TOKEN = 'ghp_SECRET_TOKEN_VALUE_123';

/** A fake GitHub: `search` answers /search/users, `org` answers /orgs/{login}. */
function fakeCtx({ search, org, token = TOKEN, places }) {
  const calls = [];
  const sleeps = [];
  const ctx = {
    table,
    zones: null,
    env: token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : {},
    log: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    searchNames: places,
    http: {
      sleep: async () => {},
      fetchJson: async (url, opts = {}) => {
        const u = new URL(url);
        calls.push({ url: u, headers: opts.headers ?? {} });
        if (u.pathname === '/search/users') return search(u);
        const login = u.pathname.replace('/orgs/', '');
        return org(login);
      },
    },
  };
  return { ctx, calls, sleeps };
}
async function collect(ctx) {
  const out = [];
  for await (const r of source.fetch(ctx)) out.push(r);
  return out;
}
const page = (items, total = items.length) => ({ total_count: total, incomplete_results: false, items });
const item = (login) => ({ login, type: 'Organization', html_url: `https://github.com/${login}` });

test('declares itself as a GitHub source with an optional token', () => {
  assert.equal(source.id, 'github-orgs');
  assert.equal(source.family, 'github');
  assert.deepEqual(source.auth, { kind: 'optional-env', vars: ['GITHUB_PERSONAL_ACCESS_TOKEN'] });
});

test('search names come from the zone table and skip names shared with a place outside the zones when unauthenticated', () => {
  const authed = searchNames(table, null, { authenticated: true });
  const anon = searchNames(table, null, { authenticated: false });
  assert.ok(authed.includes('Basel') && authed.includes('Freiburg'));
  assert.ok(anon.includes('Basel') && anon.includes('Freiburg im Breisgau'));
  assert.ok(!anon.includes('Freiburg'), 'bare Freiburg is also Fribourg, so it is skipped without a token');
  assert.ok(!anon.includes('Baden'), 'ambiguous names are skipped without a token');
  const onlyA = searchNames(table, ['A'], { authenticated: true });
  assert.ok(onlyA.includes('Colmar') && !onlyA.includes('Basel'));
});

test('queries only organisations through the search API, never users or emails', async () => {
  const { ctx, calls } = fakeCtx({ places: ['Basel'], search: () => page([item('acme-labs')]), org: () => ({ login: 'acme-labs', name: 'Acme Labs', location: 'Basel, Switzerland', blog: 'https://acme.example' }) });
  await collect(ctx);
  const search = calls.find((c) => c.url.pathname === '/search/users');
  assert.equal(search.url.hostname, 'api.github.com');
  assert.match(search.url.searchParams.get('q'), /^type:org location:"Basel"$/);
  assert.ok(calls.every((c) => c.url.pathname === '/search/users' || /^\/orgs\/[^/]+$/.test(c.url.pathname)));
});

test('with a token each organisation is read for its own location and name', async () => {
  const { ctx, calls } = fakeCtx({
    places: ['Basel'],
    search: () => page([item('acme-labs')]),
    org: () => ({ login: 'acme-labs', name: 'Acme Labs AG', location: 'Zurich, Switzerland', blog: 'https://acme.example', email: 'secret@example.com' }),
  });
  const [record] = await collect(ctx);
  assert.equal(record.name, 'Acme Labs AG');
  assert.equal(record.locationText, 'Zurich, Switzerland');
  assert.equal(record.entityId, 'github:acme-labs');
  assert.equal(record.sourceId, 'github-orgs');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(record).includes('secret@example.com'), false, 'no email is kept');
  assert.equal(JSON.stringify(record).includes(TOKEN), false, 'the token never reaches a record');
  assert.equal(zoneRecord(table, record).sites[0].zone, 'C', 'zoned from the organisation location, not the query');
});

test('without a token no Authorization header is sent and the organisation is placed at the queried place', async () => {
  const { ctx, calls } = fakeCtx({ places: ['Basel'], token: null, search: () => page([item('acme-labs')]), org: () => { throw new Error('no detail calls without a token'); } });
  const [record] = await collect(ctx);
  assert.equal(record.name, 'acme-labs');
  assert.equal(record.place, 'Basel');
  assert.ok(calls.every((c) => !('Authorization' in c.headers)));
  assert.equal(zoneRecord(table, record).sites[0].zone, 'B');
});

test('searches are paced at 6 s without a token and 2 s with one', async () => {
  const anon = fakeCtx({ places: ['Basel', 'Colmar'], token: null, search: () => page([]), org: () => ({}) });
  await collect(anon.ctx);
  assert.ok(anon.sleeps.some((ms) => ms >= 6000));
  const authed = fakeCtx({ places: ['Basel', 'Colmar'], search: () => page([]), org: () => ({}) });
  await collect(authed.ctx);
  assert.ok(authed.sleeps.every((ms) => ms < 6000) && authed.sleeps.some((ms) => ms >= 2000));
});

test('a query with more than 1000 results reads 10 pages and logs the cut-off', async () => {
  const logs = [];
  let pages = 0;
  const { ctx } = fakeCtx({ places: ['Zurich'], token: null, search: () => { pages++; return page([item(`org${pages}`)], 5000); }, org: () => ({}) });
  ctx.log = (m) => logs.push(m);
  await collect(ctx);
  assert.equal(pages, 10);
  assert.ok(logs.some((m) => /1000/.test(m) && /Zurich/.test(m)));
});

test('a rate limit waits once and then retries, a second one fails with a clear reason', async () => {
  let n = 0;
  const limited = Object.assign(new Error('HTTP 403 rate limit exceeded'), { status: 403, retryAfter: '30' });
  const { ctx, sleeps } = fakeCtx({ places: ['Basel'], search: () => { if (n++ === 0) throw limited; return page([]); }, org: () => ({}) });
  await collect(ctx);
  assert.ok(sleeps.includes(30_000), 'waited the stated Retry-After');
  const always = fakeCtx({ places: ['Basel'], search: () => { throw limited; }, org: () => ({}) });
  await assert.rejects(collect(always.ctx), /rate limit/i);
});

test('finished queries are replayed from the cache and the token is never stored', async () => {
  const store = new Map([['Basel', [{ name: 'Cached Org', sourceId: 'github-orgs', locationText: 'Basel' }]]]);
  const { ctx, calls } = fakeCtx({ places: ['Basel', 'Colmar'], search: () => page([item('new-org')]), org: () => ({ login: 'new-org', name: 'New Org', location: 'Colmar, France' }) });
  ctx.cache = { get: (u) => store.get(u) ?? null, set: (u, r) => store.set(u, r) };
  const records = await collect(ctx);
  assert.ok(records.some((r) => r.name === 'Cached Org'));
  assert.ok(calls.every((c) => c.url.pathname !== '/search/users' || c.url.searchParams.get('q').includes('Colmar')));
  assert.equal(JSON.stringify([...store.values()]).includes(TOKEN), false);
});
