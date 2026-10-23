import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  needleFor, buildNameQuery, zefixCandidates, sireneCandidates, chooseEntity, formatCandidates, parseCandidates,
  NEEDLES_PER_QUERY, makeRegisterClient, resolveSpellings, ZEFIX_PACE_MS, SIRENE_PACE_MS, LINDAS_TIMEOUT_MS, MAX_PAGES,
  firstSegment, needleVariants, NON_OPERATING_RE, GROUP_TAILS, rowFor,
} from '../radar/resolve.mjs';
import { loadZoneTable } from '../radar/zones.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-resolve-')), codeRoot: ROOT });

const LEGAL = 'https://ld.admin.ch/ech/97/legalforms/';
let seq = 0;
const zrow = (name, pc, city, over = {}) => {
  seq += 1;
  const uid = over.uid ?? `CHE1000000${String(seq).padStart(2, '0')}`;
  return {
    name: { value: name },
    form: { value: over.form ?? `${LEGAL}0106` },
    pc: { value: pc },
    city: { value: city },
    uid: { value: `https://register.ld.admin.ch/zefix/company/${seq}/UID/${uid}` },
    d: { value: over.d ?? 'Die Gesellschaft bezweckt die Softwareentwicklung und IT-Beratung.' },
    needle: { value: over.needle ?? 'x' },
  };
};
const choose = (needle, bindings) => chooseEntity(needleFor(needle), zefixCandidates(bindings.map((b) => ({ ...b, needle: { value: needleFor(needle).server } }))), { table });

test('needleFor cuts the first segment and strips the legal form', () => {
  assert.deepEqual(needleFor('Akros AG - Software'), { server: 'akros', base: 'akros' });
  assert.deepEqual(needleFor('Acme S.A.S.'), { server: 'acme', base: 'acme' });
  assert.deepEqual(needleFor('Acme GmbH & Co. KG'), { server: 'acme', base: 'acme' });
  assert.deepEqual(needleFor('Foo (Bar) | Baz'), { server: 'foo', base: 'foo' });
  assert.deepEqual(needleFor('Foo Bar, Zurich'), { server: 'foo bar', base: 'foo bar' });
});

test('needleFor keeps accents on server and folds them on base', () => {
  assert.deepEqual(needleFor('Müller Informatik GmbH'), { server: 'müller informatik', base: 'muller informatik' });
});

test('needleFor returns null for generic phrases, short names and unsafe characters', () => {
  assert.equal(needleFor('Data services'), null);
  assert.equal(needleFor('Freelance web development'), null);
  assert.equal(needleFor('AB'), null);
  assert.equal(needleFor('Acme "X"'), null);
  assert.equal(needleFor('Acme\\X'), null);
  assert.equal(needleFor(''), null);
  assert.equal(needleFor('a'.repeat(81)), null);
});

test('the by-name query has VALUES, STRSTARTS, the UID filter, ORDER BY ?needle ?name, LIMIT 500', () => {
  const q = buildNameQuery(['akros', 'dormakaba'], 500);
  assert.match(q, /VALUES \?needle \{ "akros" "dormakaba" \}/);
  assert.match(q, /FILTER\(STRSTARTS\(LCASE\(STR\(\?name\)\), \?needle\)\)/);
  assert.match(q, /FILTER\(CONTAINS\(STR\(\?uid\), "\/UID\/"\)\)/);
  assert.match(q, /ORDER BY \?needle \?name/);
  assert.match(q, /LIMIT 500/);
  assert.match(q, /OFFSET 500/);
  assert.match(q, /FROM <https:\/\/lindas\.admin\.ch\/foj\/zefix>/);
  assert.match(q, /SELECT \?name \?form \?pc \?city \?uid \?d \?needle/);
  assert.doesNotMatch(q, /REGEX/i);
});

test('the by-name query refuses empty, oversized and unsafe needle lists', () => {
  assert.throws(() => buildNameQuery([], 0));
  assert.throws(() => buildNameQuery(['a"b'], 0));
  assert.throws(() => buildNameQuery(['a\nb'], 0));
  assert.throws(() => buildNameQuery(Array.from({ length: NEEDLES_PER_QUERY + 1 }, (_, i) => `needle${i}`), 0));
  assert.equal(NEEDLES_PER_QUERY, 10);
});

test('zefixCandidates drops sole proprietorships and firms in liquidation, keeps purpose strength', () => {
  const out = zefixCandidates([
    zrow('Acme AG', '4051', 'Basel', { needle: 'acme', uid: 'CHE111111111' }),
    zrow('Acme Muster', '4051', 'Basel', { needle: 'acme', form: `${LEGAL}0101` }),
    zrow('Acme Old AG in Liquidation', '4051', 'Basel', { needle: 'acme' }),
    zrow('Acme Trade AG', '4051', 'Basel', { needle: 'acme', d: 'Handel mit Hardware und Software.' }),
    zrow('Acme AG', '4051', 'Basel', { needle: 'acme', uid: 'CHE111111111' }),
  ]);
  assert.deepEqual(out.map((c) => [c.legalName, c.entityId, c.purpose]), [
    ['Acme AG', 'uid:CHE111111111', 'strong'],
    ['Acme Trade AG', out[1].entityId, 'weak'],
  ]);
  assert.equal(out[0].country, 'CH');
  assert.equal(out[0].place, 'Basel');
  assert.equal(out[0].postcode, '4051');
  assert.equal(out[0].needle, 'acme');
  assert.doesNotMatch(JSON.stringify(out), /Gesellschaft|bezweckt|Hardware/);
});

test('sireneCandidates keeps siege plus open établissements, drops 1xxx, carries siren id, sector and band', () => {
  const out = sireneCandidates({
    results: [
      {
        siren: '111111111', nom_complet: 'ACME LOGICIEL SAS', activite_principale: '62.01Z', nature_juridique: '5710',
        tranche_effectif_salarie: '12',
        dirigeants: [{ denomination: 'SECRET PERSON' }],
        siege: { code_postal: '75001', libelle_commune: 'PARIS' },
        matching_etablissements: [
          { code_postal: '68000', libelle_commune: 'COLMAR', etat_administratif: 'A' },
          { code_postal: '68100', libelle_commune: 'MULHOUSE', etat_administratif: 'F' },
          { code_postal: '75001', libelle_commune: 'PARIS' },
        ],
      },
      { siren: '222222222', nom_complet: 'MARTIN JEAN', nature_juridique: '1000', siege: { code_postal: '68000', libelle_commune: 'COLMAR' } },
      { siren: '', nom_complet: 'NO SIREN', nature_juridique: '5710', siege: { code_postal: '68000', libelle_commune: 'COLMAR' } },
    ],
  }, 'acme');
  assert.deepEqual(out.map((c) => `${c.postcode} ${c.place}`), ['75001 PARIS', '68000 COLMAR']);
  assert.equal(out[0].entityId, 'siren:111111111');
  assert.equal(out[0].legalName, 'ACME LOGICIEL SAS');
  assert.equal(out[0].country, 'FR');
  assert.equal(out[0].sector, '62.01Z');
  assert.equal(out[0].sizeBand, '20-49');
  assert.equal(out[0].needle, 'acme');
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
  assert.deepEqual(sireneCandidates({}, 'x'), []);
});

test('abf informatik resolves to the Zug entity (6330 Cham is zone D)', () => {
  const r = choose('ABF Informatik', [zrow('ABF Informatik AG', '6330', 'Cham', { uid: 'CHE222222222' })]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.entity.legalName, 'ABF Informatik AG');
  assert.equal(r.entity.entityId, 'uid:CHE222222222');
  assert.deepEqual([r.site.place, r.site.postcode], ['Cham', '6330']);
  assert.equal(r.entity.purpose, 'strong');
});

test('an exact hit outside the zones is out-of-zone, and a token-boundary miss is not a candidate', () => {
  const r = choose('Akros', [
    zrow('Akros AG', '2502', 'Biel/Bienne'),
    zrow('AKROSWISS AG', '6300', 'Zug'),
    zrow('AkroSports AG in Liquidation', '4051', 'Basel'),
  ]);
  assert.equal(r.verdict, 'out-of-zone');
  assert.deepEqual(r.candidates.map((e) => e.legalName), ['Akros AG']);
  assert.equal(r.entity, undefined);
});

test('five out-of-zone prefix entities are out-of-zone with five candidates', () => {
  const r = choose('dormakaba', [
    zrow('dormakaba Schweiz AG', '8153', 'Rümlang'),
    zrow('dormakaba Holding AG', '8153', 'Rümlang'),
    zrow('dormakaba International Holding AG', '8153', 'Rümlang'),
    zrow('dormakaba Digital AG', '8620', 'Wetzikon ZH'),
    zrow('dormakaba Research AG', '8620', 'Wetzikon ZH'),
  ]);
  assert.equal(r.verdict, 'out-of-zone');
  assert.equal(r.candidates.length, 5);
});

test('two in-zone prefix operating entities are a brand, anchored on the best zone', () => {
  const r = choose('Foo', [zrow('Foo Basel AG', '4051', 'Basel'), zrow('Foo Zug AG', '6330', 'Cham')]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.anchor, 'brand');
  assert.equal(r.entity.legalName, 'Foo Basel AG');
  assert.equal(r.site.place, 'Basel');
  assert.equal(r.candidates.length, 2);
});

test('one in-zone prefix entity next to out-of-zone ones resolves', () => {
  const r = choose('Foo', [zrow('Foo Basel AG', '4051', 'Basel'), zrow('Foo Biel AG', '2502', 'Biel/Bienne')]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.entity.legalName, 'Foo Basel AG');
});

test('the exact rule wins over prefix entities', () => {
  const r = choose('Foo', [zrow('Foo AG', '8001', 'Zürich'), zrow('Foo Basel AG', '4051', 'Basel')]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.entity.legalName, 'Foo AG');
});

test('two exact legal names with different UIDs are a brand, anchored on the best zone', () => {
  const r = choose('Foo', [zrow('Foo AG', '8001', 'Zürich'), zrow('Foo GmbH', '4051', 'Basel')]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.anchor, 'brand');
  assert.equal(r.entity.legalName, 'Foo GmbH');
  assert.equal(r.candidates.length, 2);
});

test('no candidate is unresolved', () => {
  const r = choose('Foo', []);
  assert.equal(r.verdict, 'unresolved');
  assert.deepEqual(r.candidates, []);
});

test('a firm with an in-zone and an out-of-zone site resolves on the in-zone one', () => {
  const r = chooseEntity({ server: 'foo', base: 'foo' }, [
    { needle: 'foo', legalName: 'Foo SAS', entityId: 'siren:1', place: 'PARIS', postcode: '75001', country: 'FR', sector: '62.01Z', sizeBand: '20-49' },
    { needle: 'foo', legalName: 'Foo SAS', entityId: 'siren:1', place: 'COLMAR', postcode: '68000', country: 'FR', sector: '62.01Z', sizeBand: '20-49' },
  ], { table });
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.site.place, 'COLMAR');
  assert.equal(r.entity.sizeBand, '20-49');
});

test('formatCandidates and parseCandidates round trip', () => {
  const entities = [
    { entityId: 'uid:CHE1', legalName: 'Foo AG', sites: [{ place: 'Zürich', postcode: '8001' }] },
    { entityId: 'siren:2', legalName: 'Bar; #SAS', sites: [{ place: 'COLMAR', postcode: '68000' }] },
  ];
  const cell = formatCandidates(entities);
  assert.equal(cell, 'Foo AG @ Zürich (8001) #uid:CHE1;Bar, ,SAS @ COLMAR (68000) #siren:2');
  assert.deepEqual(parseCandidates(cell), [
    { legalName: 'Foo AG', place: 'Zürich', postcode: '8001', entityId: 'uid:CHE1' },
    { legalName: 'Bar, ,SAS', place: 'COLMAR', postcode: '68000', entityId: 'siren:2' },
  ]);
  assert.deepEqual(parseCandidates(''), []);
  assert.deepEqual(parseCandidates('garbage;;Foo AG @ Zug (6300) #uid:X'), [{ legalName: 'Foo AG', place: 'Zug', postcode: '6300', entityId: 'uid:X' }]);
});

test('formatCandidates caps at 20 entries and counts the rest', () => {
  const entities = Array.from({ length: 23 }, (_, i) => ({ entityId: `uid:C${i}`, legalName: `N${i} AG`, sites: [{ place: 'Zug', postcode: '6300' }] }));
  const cell = formatCandidates(entities);
  assert.equal(cell.split(';').length, 21);
  assert.ok(cell.endsWith(';+3 more'));
  assert.equal(parseCandidates(cell).length, 20);
});

const TODAY = '2026-10-23';
const COLUMNS = ['company', 'domain', 'country', 'legal_name', 'entity_id', 'place', 'postcode', 'sector', 'size_band', 'verdict', 'candidates', 'checked'];

/** A fake transport: `lindas(query, n)` and `sirene(q, n)` return bindings and an API answer. */
function fakeCtx({ lindas = () => [], sirene = () => ({ results: [] }), fail = null } = {}) {
  const requests = [];
  const sleeps = [];
  const logs = [];
  const ctx = {
    table,
    today: TODAY,
    log: (m) => logs.push(m),
    sleep: async (ms) => { sleeps.push(ms); },
    http: {
      sleep: async () => {},
      fetchJson: async (url, opts = {}) => {
        if (fail) throw fail;
        if (url.startsWith('https://lindas.admin.ch/query')) {
          const query = new URLSearchParams(String(opts.body ?? '')).get('query');
          requests.push({ kind: 'lindas', url, opts, query });
          return { results: { bindings: lindas(query, requests.filter((r) => r.kind === 'lindas').length) } };
        }
        const q = new URL(url).searchParams.get('q');
        requests.push({ kind: 'sirene', url, opts, q });
        return sirene(q, requests.filter((r) => r.kind === 'sirene').length);
      },
    },
  };
  return { ctx, requests, sleeps, logs };
}
const spell = (spelling, domain = '') => ({ spelling, domain, needle: needleFor(spelling) });
const byNeedle = (name, pc, city, needle, over = {}) => zrow(name, pc, city, { ...over, needle });
const frAnswer = (name, siren, sites, over = {}) => ({
  results: [{
    siren, nom_complet: name, activite_principale: '62.01Z', nature_juridique: '5710', tranche_effectif_salarie: '12',
    siege: sites[0], matching_etablissements: sites.slice(1), ...over,
  }],
});

test('LINDAS requests are POSTed with the fair-use headers and timeoutMs >= 60000', async () => {
  const { ctx, requests } = fakeCtx();
  await resolveSpellings([spell('Akros AG')], ctx);
  const [r] = requests;
  assert.equal(r.kind, 'lindas');
  assert.equal(r.opts.method, 'POST');
  assert.ok(r.opts.timeoutMs >= 60000);
  assert.equal(r.opts.timeoutMs, LINDAS_TIMEOUT_MS);
  assert.match(r.opts.headers['User-Agent'], /career-ops-radar/);
  assert.equal(r.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(r.opts.headers.Accept, /sparql-results\+json/);
});

test('two calls on one client sleep 3000 ms before the second LINDAS request and 340 ms before the second SIRENE one', async () => {
  const { ctx, sleeps } = fakeCtx();
  const client = makeRegisterClient(ctx);
  await client.zefix('q1');
  assert.deepEqual(sleeps, []);
  await client.zefix('q2');
  assert.deepEqual(sleeps, [ZEFIX_PACE_MS]);
  await client.sirene('acme');
  assert.deepEqual(sleeps, [3000]);
  await client.sirene('acme');
  assert.deepEqual(sleeps, [3000, SIRENE_PACE_MS]);
  assert.equal(SIRENE_PACE_MS, 340);
});

test('a SIRENE request is a GET on the search API with the name and open establishments only', async () => {
  const { ctx, requests } = fakeCtx();
  await makeRegisterClient(ctx).sirene('acme logiciel');
  const u = new URL(requests[0].url);
  assert.equal(`${u.origin}${u.pathname}`, 'https://recherche-entreprises.api.gouv.fr/search');
  assert.equal(u.searchParams.get('q'), 'acme logiciel');
  assert.equal(u.searchParams.get('etat_administratif'), 'A');
  assert.match(requests[0].opts.headers['User-Agent'], /career-ops-radar/);
});

test('a null needle makes no request and resolves to unresolved with no candidates', async () => {
  const { ctx, requests } = fakeCtx();
  const [row] = await resolveSpellings([spell('Data services', 'x.ch')], ctx);
  assert.equal(requests.length, 0);
  assert.deepEqual(Object.keys(row), COLUMNS);
  assert.equal(row.company, 'Data services');
  assert.equal(row.domain, 'x.ch');
  assert.equal(row.verdict, 'unresolved');
  assert.equal(row.candidates, '');
  assert.equal(row.checked, TODAY);
});

test('a Zefix hit fills the entity, the software marker and the zone place', async () => {
  const { ctx, requests } = fakeCtx({
    lindas: () => [byNeedle('ABF Informatik AG', '6330', 'Cham', 'abf informatik', { uid: 'CHE222222222' })],
  });
  const [row] = await resolveSpellings([spell('ABF Informatik')], ctx);
  assert.equal(requests.length, 1);
  assert.deepEqual(row, {
    company: 'ABF Informatik', domain: '', country: 'CH', legal_name: 'ABF Informatik AG', entity_id: 'uid:CHE222222222',
    place: 'Cham', postcode: '6330', sector: 'zefix-purpose:software', size_band: '?', verdict: 'resolved', candidates: '', checked: TODAY,
  });
});

test('a weak Zefix purpose leaves sector empty', async () => {
  const { ctx } = fakeCtx({
    lindas: () => [byNeedle('Foo AG', '4051', 'Basel', 'foo', { d: 'Handel mit Hardware und Software.' })],
  });
  const [row] = await resolveSpellings([spell('Foo')], ctx);
  assert.equal(row.verdict, 'resolved');
  assert.equal(row.sector, '');
});

test('ambiguous and out-of-zone rows fill candidates only', async () => {
  const { ctx } = fakeCtx({
    lindas: () => [
      byNeedle('Foo Holding AG', '4051', 'Basel', 'foo', { uid: 'CHE111111111' }),
      byNeedle('Foo Stiftung', '6330', 'Cham', 'foo', { uid: 'CHE222222222' }),
      byNeedle('Akros AG', '2502', 'Biel/Bienne', 'akros', { uid: 'CHE333333333' }),
    ],
  });
  const [amb, oz] = await resolveSpellings([spell('Foo'), spell('Akros')], ctx);
  assert.equal(amb.verdict, 'ambiguous');
  assert.equal(amb.candidates, 'Foo Holding AG @ Basel (4051) #uid:CHE111111111;Foo Stiftung @ Cham (6330) #uid:CHE222222222');
  assert.deepEqual([amb.country, amb.legal_name, amb.entity_id, amb.place, amb.postcode, amb.sector, amb.size_band], ['', '', '', '', '', '', '']);
  assert.equal(oz.verdict, 'out-of-zone');
  assert.equal(oz.candidates, 'Akros AG @ Biel/Bienne (2502) #uid:CHE333333333');
  assert.equal(oz.entity_id, '');
  assert.equal(oz.place, '');
});

test('one LINDAS query carries every needle of the batch', async () => {
  const { ctx, requests } = fakeCtx();
  await resolveSpellings([spell('Akros AG'), spell('Müller Informatik GmbH'), spell('Akros')], ctx);
  const lindas = requests.filter((r) => r.kind === 'lindas');
  assert.equal(lindas.length, 1);
  assert.match(lindas[0].query, /VALUES \?needle \{ "akros" "müller informatik" \}/);
});

test('a .fr domain goes to SIRENE first and never reaches LINDAS when it resolves', async () => {
  const { ctx, requests } = fakeCtx({
    sirene: () => frAnswer('ACME LOGICIEL SAS', '111111111', [
      { code_postal: '75001', libelle_commune: 'PARIS' },
      { code_postal: '68000', libelle_commune: 'COLMAR' },
    ]),
  });
  const [row] = await resolveSpellings([spell('Acme Logiciel', 'acme.fr')], ctx);
  assert.deepEqual(requests.map((r) => r.kind), ['sirene']);
  assert.equal(requests[0].q, 'acme logiciel');
  assert.deepEqual(
    [row.verdict, row.country, row.legal_name, row.entity_id, row.place, row.postcode, row.sector, row.size_band],
    ['resolved', 'FR', 'ACME LOGICIEL SAS', 'siren:111111111', 'COLMAR', '68000', '62.01Z', '20-49'],
  );
});

test('an unresolved .fr spelling falls back to LINDAS exactly once', async () => {
  const { ctx, requests } = fakeCtx({
    lindas: () => [byNeedle('Acme AG', '8001', 'Zürich', 'acme', { uid: 'CHE444444444' })],
  });
  const [row] = await resolveSpellings([spell('Acme', 'acme.fr')], ctx);
  assert.deepEqual(requests.map((r) => r.kind), ['sirene', 'lindas']);
  assert.equal(row.verdict, 'resolved');
  assert.equal(row.country, 'CH');
});

test('an unresolved Zefix spelling falls back to SIRENE exactly once', async () => {
  const { ctx, requests } = fakeCtx({
    sirene: () => frAnswer('ACME SAS', '555555555', [{ code_postal: '68100', libelle_commune: 'MULHOUSE' }]),
  });
  const [row] = await resolveSpellings([spell('Acme', 'acme.ch')], ctx);
  assert.deepEqual(requests.map((r) => r.kind), ['lindas', 'sirene']);
  assert.equal(row.verdict, 'resolved');
  assert.equal(row.country, 'FR');
  assert.equal(row.entity_id, 'siren:555555555');
});

test('an out-of-zone first answer does not trigger the second register', async () => {
  const { ctx, requests } = fakeCtx({ lindas: () => [byNeedle('Akros AG', '2502', 'Biel/Bienne', 'akros')] });
  const [row] = await resolveSpellings([spell('Akros')], ctx);
  assert.deepEqual(requests.map((r) => r.kind), ['lindas']);
  assert.equal(row.verdict, 'out-of-zone');
});

test('a full page is followed by OFFSET 500 and a short page ends the paging, 3000 ms apart', async () => {
  const { ctx, requests, sleeps } = fakeCtx({
    lindas: (q, n) => (n === 1
      ? Array.from({ length: 500 }, (_, i) => byNeedle(`Zed ${i} AG`, '8001', 'Zürich', 'foo'))
      : [byNeedle('Foo AG', '4051', 'Basel', 'foo')]),
  });
  const [row] = await resolveSpellings([spell('Foo')], ctx);
  assert.equal(requests.length, 2);
  assert.match(requests[0].query, /OFFSET 0/);
  assert.match(requests[1].query, /OFFSET 500/);
  assert.deepEqual(sleeps, [ZEFIX_PACE_MS]);
  assert.equal(row.verdict, 'resolved');
  assert.equal(row.legal_name, 'Foo AG');
});

test('more than 20 pages throws and names the needles', async () => {
  const { ctx, requests } = fakeCtx({ lindas: () => Array.from({ length: 500 }, (_, i) => byNeedle(`Zed ${i} AG`, '8001', 'Zürich', 'foo')) });
  await assert.rejects(resolveSpellings([spell('Foo')], ctx), /candiboost: by-name query exceeds 20 pages \(needles: foo\)/);
  assert.equal(requests.length, MAX_PAGES);
});

test('an HTTP 500 rejects the whole call', async () => {
  const { ctx } = fakeCtx({ fail: Object.assign(new Error('HTTP 500'), { status: 500 }) });
  await assert.rejects(resolveSpellings([spell('Foo')], ctx), /HTTP 500/);
});

test('more than 10 spellings throw before any request', async () => {
  const { ctx, requests } = fakeCtx();
  const many = Array.from({ length: NEEDLES_PER_QUERY + 1 }, (_, i) => spell(`Company${i}`));
  await assert.rejects(resolveSpellings(many, ctx), /at most 10/);
  assert.equal(requests.length, 0);
});

test('an injected client is used instead of a new one', async () => {
  const calls = [];
  const client = { zefix: async (q) => { calls.push(q); return { results: { bindings: [] } }; }, sirene: async () => ({ results: [] }) };
  const [row] = await resolveSpellings([spell('Foo')], { table, today: TODAY, client });
  assert.equal(calls.length, 1);
  assert.equal(row.verdict, 'unresolved');
});

test('firstSegment cuts at a separator and drops parentheticals', () => {
  assert.equal(firstSegment('Gruner AG, Gebäudetechnik Basel'), 'Gruner AG');
  assert.equal(firstSegment('Foo (Bar) | Baz'), 'Foo');
  assert.equal(firstSegment(''), '');
});

test('needleVariants drops group tails, "part of" and spaces around +', () => {
  assert.deepEqual(needleVariants('Sonova Group'), [{ server: 'sonova', base: 'sonova' }]);
  assert.deepEqual(needleVariants('Baloise CH'), [{ server: 'baloise', base: 'baloise' }]);
  assert.deepEqual(needleVariants('Leica Geosystems part of Hexagon'), [{ server: 'leica geosystems', base: 'leica geosystems' }]);
  assert.deepEqual(needleVariants('Endress + Hauser Process Solutions AG'), [{ server: 'endress+hauser process solutions', base: 'endress hauser process solutions' }]);
  assert.deepEqual(needleVariants('Swatch Group Services').map((v) => v.server), ['swatch group', 'swatch']);
  assert.deepEqual(needleVariants('Akros AG'), []);
  assert.deepEqual(needleVariants('Group'), []);
  assert.deepEqual(needleVariants('Data services'), []);
  assert.ok(GROUP_TAILS.has('holding'));
});

test('NON_OPERATING_RE flags foundations, funds and law firms and nothing else of the samples', () => {
  for (const n of ['AXA Anlagestiftung', 'HBL Freizügigkeitsstiftung', 'Siemens Healthineers Pension Fund', 'PLANZER LAW AG', 'HBL Finanz AG', 'Foo Holding AG']) {
    assert.ok(NON_OPERATING_RE.test(n), n);
  }
  for (const n of ['PostFinance AG', 'Anlagenbau AG', 'Lawson AG', 'Coop Pronto AG']) assert.ok(!NON_OPERATING_RE.test(n), n);
});

test('brand rule: two exact entities in one zone pick the smaller UID', () => {
  const r = choose('Helbling Technik', [
    zrow('Helbling Technik AG', '8001', 'Zürich', { uid: 'CHE222222222' }),
    zrow('Helbling Technik AG', '8005', 'Zürich', { uid: 'CHE111111111' }),
  ]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.anchor, 'brand');
  assert.equal(r.entity.entityId, 'uid:CHE111111111');
});

test('brand rule: Coop picks the shortest operating legal name in the best zone', () => {
  const r = choose('Coop', [
    zrow('Coop Genossenschaft', '4051', 'Basel'),
    zrow('Coop Pronto AG', '4123', 'Allschwil'),
    zrow('Coop Immobilien AG', '4051', 'Basel'),
    zrow('Coop Pensionskasse', '8001', 'Zürich'),
  ]);
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.entity.legalName, 'Coop Pronto AG');
  assert.equal(r.candidates.length, 4);
});

test('brand rule: Rondo drops the foundation and the real-estate entity', () => {
  const r = choose('Rondo', [
    zrow('Rondo Stiftung', '4051', 'Basel'),
    zrow('RONDO Musikreisen GmbH', '4051', 'Basel'),
    zrow('Rondo Immobilien AG', '4051', 'Basel'),
  ]);
  assert.equal(r.entity.legalName, 'RONDO Musikreisen GmbH');
});

test('brand rule: only non-operating entities stay ambiguous', () => {
  const r = choose('BLKB', [zrow('BLKB Pensionskasse', '4051', 'Basel'), zrow('BLKB Anlagestiftung', '4051', 'Basel')]);
  assert.equal(r.verdict, 'ambiguous');
  assert.equal(r.candidates.length, 2);
});

test('brand rule: an out-of-zone operating entity does not anchor a brand', () => {
  const r = choose('Foo', [zrow('Foo AG', '2502', 'Biel/Bienne'), zrow('Foo Holding AG', '4051', 'Basel'), zrow('Foo GmbH', '2502', 'Biel/Bienne')]);
  assert.equal(r.verdict, 'ambiguous');
});

test('rowFor writes the candidates of a brand pick and the purpose-based sector', () => {
  const picked = choose('Foo', [zrow('Foo Basel AG', '4051', 'Basel', { uid: 'CHE111111111' }), zrow('Foo Zug AG', '6330', 'Cham', { uid: 'CHE222222222' })]);
  const row = rowFor({ spelling: 'Foo', domain: '' }, 'resolved', picked, TODAY);
  assert.equal(row.entity_id, 'uid:CHE111111111');
  assert.equal(row.sector, 'zefix-purpose:software');
  assert.equal(row.candidates, 'Foo Basel AG @ Basel (4051) #uid:CHE111111111;Foo Zug AG @ Cham (6330) #uid:CHE222222222');
  const plain = choose('Bar', [zrow('Bar AG', '4051', 'Basel')]);
  assert.equal(rowFor({ spelling: 'Bar' }, 'resolved', plain, TODAY).candidates, '');
});

test('a spelling without candidates retries its variants in one more query', async () => {
  const { ctx, requests, sleeps } = fakeCtx({
    lindas: (q, n) => (n === 2 ? [byNeedle('Sonova AG', '8001', 'Zürich', 'sonova')] : []),
  });
  const [row] = await resolveSpellings([spell('Sonova Group')], ctx);
  const lindas = requests.filter((r) => r.kind === 'lindas');
  assert.equal(lindas.length, 2);
  assert.match(lindas[0].query, /VALUES \?needle \{ "sonova group" \}/);
  assert.match(lindas[1].query, /VALUES \?needle \{ "sonova" \}/);
  assert.ok(sleeps.includes(3000));
  assert.equal(row.verdict, 'resolved');
  assert.equal(row.legal_name, 'Sonova AG');
  assert.equal(requests.filter((r) => r.kind === 'sirene').length, 0);
});

test('no variant query when the primary needle resolves', async () => {
  const { ctx, requests } = fakeCtx({ lindas: () => [byNeedle('Sonova Group AG', '8001', 'Zürich', 'sonova group')] });
  const [row] = await resolveSpellings([spell('Sonova Group')], ctx);
  assert.equal(requests.length, 1);
  assert.equal(row.verdict, 'resolved');
});

test('twenty variant needles go out in two chunks', async () => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];
  const { ctx, requests } = fakeCtx();
  await resolveSpellings(names.map((n) => spell(`${n} Group Services`)), ctx);
  const lindas = requests.filter((r) => r.kind === 'lindas');
  assert.equal(lindas.length, 3);
  const needlesIn = (q) => (/VALUES \?needle \{ (.*) \}/.exec(q)[1].match(/"/g) ?? []).length / 2;
  assert.deepEqual(lindas.map((r) => needlesIn(r.query)), [10, 10, 10]);
});

test('a page-capped variant chunk is logged and skipped', async () => {
  const { ctx, logs } = fakeCtx({
    lindas: (q, n) => (n === 1 ? [] : Array.from({ length: 500 }, (_, i) => byNeedle(`Zed ${i} AG`, '8001', 'Zürich', 'sonova'))),
  });
  const [row] = await resolveSpellings([spell('Sonova Group')], ctx);
  assert.equal(row.verdict, 'unresolved');
  assert.ok(logs.some((l) => /^candiboost: variant query skipped: .*exceeds 20 pages/.test(l)), logs.join('|'));
});

test('an HTTP 500 in the variant pass rejects the call', async () => {
  const { ctx } = fakeCtx({ lindas: (q, n) => { if (n >= 2) throw Object.assign(new Error('HTTP 500'), { status: 500 }); return []; } });
  await assert.rejects(resolveSpellings([spell('Sonova Group')], ctx), /HTTP 500/);
});

test('ctx.site patches only register-unresolved rows and keeps the column order', async () => {
  const calls = [];
  const site = async (spelling, info, c) => {
    calls.push({ spelling, info, sameCtx: c === ctxRef });
    return { verdict: 'site', country: 'CH', legal_name: 'Kobold GmbH', entity_id: 'site:kobold.ch', place: 'Allschwil', postcode: '4123', size_band: '?', candidates: 'x' };
  };
  const { ctx } = fakeCtx({ lindas: () => [byNeedle('Foo AG', '4051', 'Basel', 'foo')] });
  const ctxRef = { ...ctx, site };
  const rows = await resolveSpellings([spell('Foo'), spell('Kobold', 'kobold.ch'), spell('Data services', 'x.ch')], ctxRef);
  assert.deepEqual(rows.map((r) => r.verdict), ['resolved', 'site', 'site']);
  assert.deepEqual(rows.map((r) => Object.keys(r)), [COLUMNS, COLUMNS, COLUMNS]);
  assert.deepEqual(calls.map((c) => c.spelling), ['Kobold', 'Data services']);
  assert.deepEqual(calls[0].info, { domain: 'kobold.ch', needle: { server: 'kobold', base: 'kobold' }, variants: [] });
  assert.deepEqual(calls[1].info, { domain: 'x.ch', needle: null, variants: [] });
  assert.ok(calls.every((c) => c.sameCtx));
  assert.equal(rows[1].company, 'Kobold');
  assert.equal(rows[1].checked, TODAY);
});

test('a site hook returning null or a non-function ctx.site leaves the row alone', async () => {
  const { ctx } = fakeCtx();
  const [a] = await resolveSpellings([spell('Foo')], { ...ctx, site: async () => null });
  const [b] = await resolveSpellings([spell('Foo')], { ...ctx, site: null });
  assert.equal(a.verdict, 'unresolved');
  assert.deepEqual(a, b);
});
