import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  needleFor, buildNameQuery, zefixCandidates, sireneCandidates, chooseEntity, formatCandidates, parseCandidates,
  NEEDLES_PER_QUERY,
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

test('two in-zone prefix entities are ambiguous', () => {
  const r = choose('Foo', [zrow('Foo Basel AG', '4051', 'Basel'), zrow('Foo Zug AG', '6330', 'Cham')]);
  assert.equal(r.verdict, 'ambiguous');
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

test('two exact legal names with different UIDs are ambiguous', () => {
  const r = choose('Foo', [zrow('Foo AG', '8001', 'Zürich'), zrow('Foo GmbH', '4051', 'Basel')]);
  assert.equal(r.verdict, 'ambiguous');
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
