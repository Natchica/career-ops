import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import source, { chPostcodes, batches, purposeStrength, buildQuery } from '../radar/sources/zefix.mjs';
import { loadZoneTable, zoneRecord } from '../radar/zones.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-zefix-')), codeRoot: ROOT });

const LEGAL = 'https://ld.admin.ch/ech/97/legalforms/';
const row = (over = {}) => ({
  s: { value: 'https://register.ld.admin.ch/zefix/company/1' },
  name: { value: 'Acme Software AG' },
  form: { value: `${LEGAL}0106` },
  pc: { value: '4051' },
  city: { value: 'Basel' },
  uid: { value: 'https://register.ld.admin.ch/zefix/company/1/UID/CHE123456789' },
  d: { value: 'Die Gesellschaft bezweckt die Softwareentwicklung und IT-Beratung.' },
  ...over,
});
const answer = (rows) => ({ head: { vars: [] }, results: { bindings: rows } });

/** A fake LINDAS endpoint: `handler` gets the SPARQL text and returns the bindings. */
function fakeCtx(handler, extra = {}) {
  const requests = [];
  const sleeps = [];
  const logs = [];
  const ctx = {
    table,
    zones: null,
    postcodes: ['4051', '4052'],
    log: (m) => logs.push(m),
    sleep: async (ms) => { sleeps.push(ms); },
    http: {
      sleep: async () => {},
      fetchJson: async (url, opts = {}) => {
        const query = new URLSearchParams(String(opts.body ?? '')).get('query');
        requests.push({ url, opts, query });
        return answer(handler(query, requests.length));
      },
    },
    ...extra,
  };
  return { ctx, requests, sleeps, logs };
}
async function collect(ctx) {
  const out = [];
  for await (const r of source.fetch(ctx)) out.push(r);
  return out;
}

test('declares itself as a zero-auth company register source', () => {
  assert.equal(source.id, 'zefix');
  assert.equal(source.family, 'register');
  assert.equal(source.auth.kind, 'none');
});

test('Swiss postcodes come from the zone table and only from Swiss places', () => {
  const all = chPostcodes(table, null);
  assert.ok(all.includes('4051') && all.includes('8001') && all.includes('6300') && all.includes('3011'));
  assert.ok(all.every((cp) => /^\d{4}$/.test(cp)), 'four-digit Swiss codes only');
  assert.ok(!all.includes('68000'));
  const zoneB = chPostcodes(table, ['B']);
  assert.ok(zoneB.includes('4051') && !zoneB.includes('8001'));
});

test('postcodes are split into batches of at most 25, none lost', () => {
  const codes = Array.from({ length: 60 }, (_, i) => String(4000 + i));
  const out = batches(codes);
  assert.deepEqual(out.map((b) => b.length), [25, 25, 10]);
  assert.deepEqual(out.flat(), codes);
});

test('purpose text is graded: building software counts, merely trading it does not', () => {
  assert.equal(purposeStrength('Die Gesellschaft bezweckt die Softwareentwicklung.'), 'strong');
  assert.equal(purposeStrength('Entwicklung und Vertrieb von Software und Hardware.'), 'strong');
  assert.equal(purposeStrength('Erbringung von Informatik-Dienstleistungen aller Art'), 'strong');
  assert.equal(purposeStrength('Software Consulting-Dienstleistungen'), 'strong');
  assert.equal(purposeStrength('le développement de logiciels et les services informatiques'), 'strong');
  assert.equal(purposeStrength('Development of software for banks'), 'strong');
  assert.equal(purposeStrength('Handel mit Hard- und Software'), 'weak');
  assert.equal(purposeStrength('Die Gesellschaft erwirbt Beteiligungen, auch im Bereich Software'), 'weak');
  assert.equal(purposeStrength('Betrieb eines Restaurants'), null);
  assert.equal(purposeStrength(''), null);
  assert.equal(purposeStrength(undefined), null);
});

test('the query is bounded, ordered, filtered early and asks only for what it needs', () => {
  const q = buildQuery(['4051', '4052'], 0);
  assert.match(q, /FROM <https:\/\/lindas\.admin\.ch\/foj\/zefix>/);
  assert.match(q, /VALUES \?pc \{ "4051" "4052" \}/);
  assert.match(q, /ORDER BY \?s/);
  assert.match(q, /LIMIT 500/);
  assert.match(q, /OFFSET 0/);
  assert.doesNotMatch(q, /REGEX/i);
  assert.doesNotMatch(q, /SELECT \*/);
  assert.match(buildQuery(['4051'], 1000), /OFFSET 1000/);
});

test('only plain four-digit postcodes can reach the query text', () => {
  assert.throws(() => buildQuery(['4051" } DROP'], 0), /postcode/i);
  assert.throws(() => buildQuery([], 0), /postcode/i);
});

test('requests follow the LINDAS fair-use rules', async () => {
  const { ctx, requests } = fakeCtx(() => []);
  await collect(ctx);
  const r = requests[0];
  assert.equal(r.url, 'https://lindas.admin.ch/query');
  assert.equal(r.opts.method, 'POST');
  assert.match(r.opts.headers.Accept, /sparql-results\+json/);
  assert.match(r.opts.headers['User-Agent'], /career-ops-radar/);
  assert.match(r.opts.headers['Content-Type'], /x-www-form-urlencoded/);
});

test('strong matches become records, weak ones and sole proprietors are dropped, and the text is never kept', async () => {
  const rows = [
    row(),
    row({ name: { value: 'Weak Trading AG' }, uid: { value: 'https://x/UID/CHE222222222' }, d: { value: 'Handel mit Hard- und Software.' } }),
    row({ name: { value: 'Max Muster Webdesign' }, uid: { value: 'https://x/UID/CHE333333333' }, form: { value: `${LEGAL}0101` } }),
  ];
  const { ctx, logs } = fakeCtx(() => rows);
  const records = await collect(ctx);
  assert.equal(records.length, 1);
  const [rec] = records;
  assert.equal(rec.name, 'Acme Software AG');
  assert.equal(rec.entityId, 'uid:CHE123456789');
  assert.equal(rec.place, 'Basel');
  assert.equal(rec.postcode, '4051');
  assert.equal(rec.country, 'CH');
  assert.equal(rec.sector, 'zefix-purpose:software');
  assert.deepEqual(rec.signalTokens, ['zefix:software']);
  assert.equal(rec.sourceId, 'zefix');
  assert.equal(rec.sizeBand, '?');
  assert.equal(JSON.stringify(records).includes('Softwareentwicklung'), false, 'the purpose text is not stored');
  assert.equal(JSON.stringify(records).includes('Max Muster'), false);
  assert.ok(logs.some((m) => /1 weak/.test(m)), 'the number of weak matches is reported');
});

test('a record is zoned from its postcode', async () => {
  const { ctx } = fakeCtx(() => [row({ pc: { value: '8001' }, city: { value: 'Zürich' } })]);
  const [rec] = await collect(ctx);
  assert.deepEqual(zoneRecord(table, rec).sites, [{ place: 'Zurich', zone: 'C', country: 'CH' }]);
});

test('the same company returned twice is emitted once', async () => {
  const { ctx } = fakeCtx(() => [row(), row()]);
  assert.equal((await collect(ctx)).length, 1);
});

test('a full page asks for the next one and a short page stops', async () => {
  const full = Array.from({ length: 500 }, (_, i) => row({ uid: { value: `https://x/UID/CHE${String(100000000 + i)}` }, name: { value: `Firm ${i} Software AG` } }));
  const { ctx, requests } = fakeCtx((_q, n) => (n === 1 ? full : [row({ uid: { value: 'https://x/UID/CHE999999999' } })]));
  const records = await collect(ctx);
  assert.equal(requests.length, 2);
  assert.match(requests[0].query, /OFFSET 0/);
  assert.match(requests[1].query, /OFFSET 500/);
  assert.equal(records.length, 501);
});

test('requests are spaced at least 3 seconds apart', async () => {
  const { ctx, sleeps } = fakeCtx(() => []);
  ctx.postcodes = Array.from({ length: 60 }, (_, i) => String(4000 + i));
  await collect(ctx);
  assert.equal(sleeps.length, 2, 'three batches, two pauses');
  assert.ok(sleeps.every((ms) => ms >= 3000));
});

test('progress is logged per batch', async () => {
  const { ctx, logs } = fakeCtx(() => []);
  ctx.postcodes = Array.from({ length: 30 }, (_, i) => String(4000 + i));
  await collect(ctx);
  assert.deepEqual(logs.filter((m) => /batch/.test(m)), ['zefix: batch 1/2 done', 'zefix: batch 2/2 done']);
});

test('finished batches are replayed from the cache and fresh ones stored', async () => {
  const cached = [{ name: 'Cached Software AG', sourceId: 'zefix', country: 'CH', place: 'Basel', postcode: '4051' }];
  const store = new Map([['4051-4052', cached]]);
  const { ctx, requests } = fakeCtx(() => []);
  ctx.cache = { get: (u) => store.get(u) ?? null, set: (u, r) => store.set(u, r) };
  const records = await collect(ctx);
  assert.deepEqual(records, cached);
  assert.equal(requests.length, 0);
  ctx.postcodes = ['5000', '5001'];
  await collect(ctx);
  assert.ok(store.has('5000-5001'));
});

test('a failing request surfaces as an error and not as an empty census', async () => {
  const { ctx } = fakeCtx(() => { throw Object.assign(new Error('HTTP 500'), { status: 500 }); });
  await assert.rejects(collect(ctx), /HTTP 500/);
});
