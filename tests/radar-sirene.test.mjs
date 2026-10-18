import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import source, { sizeBand, zonePostcodes } from '../radar/sources/sirene.mjs';
import { loadZoneTable } from '../radar/zones.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'radar', name), 'utf-8'));
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-sirene-')), codeRoot: ROOT });

/** A fake transport that records every URL and answers from `handler`. */
function fakeCtx(handler, extra = {}) {
  const urls = [];
  const sleeps = [];
  return {
    urls,
    sleeps,
    ctx: {
      table,
      zones: null,
      sleep: async (ms) => { sleeps.push(ms); },
      http: { fetchJson: async (url) => { urls.push(url); return handler(new URL(url), urls.length); }, sleep: async () => {} },
      ...extra,
    },
  };
}
async function collect(ctx) {
  const out = [];
  for await (const record of source.fetch(ctx)) out.push(record);
  return out;
}
const pageHandler = (url) => (url.searchParams.get('page') === '2' ? fixture('sirene-page2.json') : fixture('sirene-page1.json'));

test('declares itself as a zero-auth register source', () => {
  assert.equal(source.id, 'sirene');
  assert.equal(source.family, 'register');
  assert.equal(source.auth.kind, 'none');
});

test('INSEE size codes map to bands and unknown codes to ?', () => {
  assert.equal(sizeBand('12'), '20-49');
  assert.equal(sizeBand('53'), '10000+');
  assert.equal(sizeBand('NN'), '?');
  assert.equal(sizeBand('00'), '?');
  assert.equal(sizeBand(undefined), '?');
});

test('zone postcodes come from the French places of the zone table', () => {
  const all = zonePostcodes(table, null);
  assert.ok(all.includes('68000') && all.includes('67000') && all.includes('90000'));
  assert.ok(!all.some((cp) => cp.length !== 5), 'only 5-digit French codes');
  const onlyA = zonePostcodes(table, ['A']);
  assert.ok(onlyA.includes('68000'));
  assert.ok(!onlyA.includes('67000'), 'Strasbourg is zone B');
});

test('emits one record per matching establishment, from the establishment and not the head office', async () => {
  const { ctx } = fakeCtx(pageHandler);
  ctx.postcodes = ['68000'];
  const records = await collect(ctx);
  const acme = records.find((r) => r.entityId === 'siren:111111111');
  assert.equal(acme.name, 'ACME LOGICIEL');
  assert.equal(acme.legalName, 'ACME LOGICIEL SAS');
  assert.equal(acme.postcode, '68000');
  assert.equal(acme.place, 'COLMAR');
  assert.equal(acme.country, 'FR');
  assert.equal(acme.sector, '62.01Z');
  assert.equal(acme.sizeBand, '20-49');
  assert.equal(acme.sourceId, 'sirene');
});

test('sole proprietors are skipped and personal data never reaches a record', async () => {
  const { ctx } = fakeCtx(pageHandler);
  ctx.postcodes = ['68000'];
  const records = await collect(ctx);
  assert.equal(records.some((r) => r.entityId === 'siren:222222222'), false);
  assert.equal(JSON.stringify(records).includes('Dupont'), false);
  assert.equal(JSON.stringify(records).includes('dirigeants'), false);
});

test('pages are walked to total_pages and the query carries the employer filters', async () => {
  const { ctx, urls } = fakeCtx(pageHandler);
  ctx.postcodes = ['68000'];
  const records = await collect(ctx);
  assert.equal(urls.length, 2);
  const first = new URL(urls[0]);
  assert.equal(first.hostname, 'recherche-entreprises.api.gouv.fr');
  assert.equal(first.searchParams.get('code_postal'), '68000');
  assert.equal(first.searchParams.get('etat_administratif'), 'A');
  assert.equal(first.searchParams.get('per_page'), '25');
  const tranches = first.searchParams.get('tranche_effectif_salarie').split(',');
  assert.ok(tranches.includes('12') && !tranches.includes('00') && !tranches.includes('NN'));
  assert.equal(records.length, 2, 'ACME and the bakery; the sole proprietor is dropped');
});

test('requests are paced at no more than 3 per second', async () => {
  const { ctx, sleeps } = fakeCtx(pageHandler);
  ctx.postcodes = ['68000'];
  await collect(ctx);
  assert.equal(sleeps.length, 1, 'one pause between two requests');
  assert.ok(sleeps[0] >= 334);
});

test('a postcode over the 10000-result cap is split by activity section', async () => {
  const sections = [];
  const { ctx } = fakeCtx((url) => {
    const section = url.searchParams.get('section_activite_principale');
    if (!section) return { results: [], total_results: 12000, page: 1, per_page: 25, total_pages: 400 };
    sections.push(section);
    return { results: [], total_results: 10, page: 1, per_page: 25, total_pages: 1 };
  });
  ctx.postcodes = ['67000'];
  await collect(ctx);
  assert.equal(sections.length, 21, 'sections A to U');
  assert.deepEqual([sections[0], sections[20]], ['A', 'U']);
});

test('a section still over the cap is split by size tranche, so no sweep stays over the cap', async () => {
  const seenTranches = [];
  const { ctx } = fakeCtx((url) => {
    const section = url.searchParams.get('section_activite_principale');
    const tranches = url.searchParams.get('tranche_effectif_salarie').split(',');
    if (!section || (section === 'J' && tranches.length > 1)) return { results: [], total_results: 12000, page: 1, per_page: 25, total_pages: 400 };
    if (section === 'J') seenTranches.push(tranches[0]);
    return { results: [], total_results: 5, page: 1, per_page: 25, total_pages: 1 };
  });
  ctx.postcodes = ['67000'];
  await collect(ctx);
  assert.equal(seenTranches.length, 14, 'one request per size tranche');
});

test('completed postcodes are replayed from the cache and fresh ones are stored', async () => {
  const store = new Map([['68000', [{ name: 'Cached SARL', sourceId: 'sirene', country: 'FR', place: 'COLMAR', postcode: '68000' }]]]);
  const { ctx, urls } = fakeCtx(pageHandler);
  ctx.postcodes = ['68000', '68100'];
  ctx.cache = { get: (unit) => store.get(unit) ?? null, set: (unit, records) => store.set(unit, records) };
  const records = await collect(ctx);
  assert.ok(records.some((r) => r.name === 'Cached SARL'));
  assert.ok(urls.every((u) => new URL(u).searchParams.get('code_postal') === '68100'), 'only the uncached postcode is fetched');
  assert.ok(store.has('68100'));
  assert.equal(JSON.stringify([...store.values()]).includes('dirigeants'), false);
});

test('a failing request surfaces as an error and not as an empty census', async () => {
  const { ctx } = fakeCtx(() => { throw new Error('HTTP 500'); });
  ctx.postcodes = ['68000'];
  await assert.rejects(collect(ctx), /HTTP 500/);
});
