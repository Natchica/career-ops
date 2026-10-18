import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseKey, mergeRecords, countSignals } from '../radar/identity.mjs';
import { buildCompanyCanonicalizer } from '../scan.mjs';

const canon = buildCompanyCanonicalizer({});
const TODAY = '2026-10-18';
const rec = (over) => ({
  name: 'Acme',
  country: 'FR',
  sites: [{ place: 'Colmar', zone: 'A', country: 'FR' }],
  sourceId: 'sirene',
  ...over,
});
const merge = (rows, records, opts = {}) => mergeRecords(rows, records, { canon, today: TODAY, portalsNames: new Map(), ...opts });

test('legal-form and parenthetical variants share one base key', () => {
  assert.equal(baseKey('ACME SAS'), 'acme');
  assert.equal(baseKey('Acme S.A.S.'), 'acme');
  assert.equal(baseKey('ACME (ACME SAS)'), 'acme');
  assert.equal(baseKey('Acme GmbH & Co. KG'), 'acme');
});

test('descriptors are never stripped, only legal forms', () => {
  assert.notEqual(baseKey('Data Solutions'), baseKey('Data Corp'));
  assert.equal(baseKey('Novartis Pharma AG'), 'novartis pharma');
  assert.notEqual(baseKey('Novartis AG'), baseKey('Novartis Pharma AG'));
});

test('a company_aliases entry links names the legal-form rule keeps apart', () => {
  const linked = buildCompanyCanonicalizer({ Novartis: ['Novartis Pharma AG'] });
  const { rows } = merge([], [rec({ name: 'Novartis AG' }), rec({ name: 'Novartis Pharma AG' })], { canon: linked });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'novartis');
});

test('legal-form variants of one firm merge into a single prospect', () => {
  const { rows, newKeys } = merge([], [rec({ name: 'ACME SAS' }), rec({ name: 'Acme S.A.S.', legalName: 'ACME SAS' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'acme');
  assert.deepEqual(newKeys, ['acme']);
});

test('two entities with the same name but different register ids stay separate', () => {
  const a = rec({ name: 'Optimum', entityId: 'siren:111111111', sites: [{ place: 'Colmar', zone: 'A', country: 'FR' }] });
  const b = rec({ name: 'Optimum', entityId: 'siren:222222222', sites: [{ place: 'Mulhouse', zone: 'A', country: 'FR' }] });
  const { rows, collisions } = merge([], [a, b]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, 'optimum');
  assert.equal(rows[1].key, 'optimum|FR|mulhouse');
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].key, 'optimum');
});

test('the same name from two sources merges, unioning sites and sources', () => {
  const a = rec({ name: 'Acme SAS', sourceId: 'sirene', sector: '62.01Z Programmation informatique' });
  const b = rec({ name: 'Acme', sourceId: 'github-orgs', sites: [{ place: 'Basel', zone: 'B', country: 'CH' }], country: 'CH' });
  const { rows } = merge([], [a, b]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sites, 'Colmar:A;Basel:B');
  assert.equal(rows[0].sources, 'sirene;github-orgs');
  assert.equal(rows[0].country, 'FR');
  assert.equal(rows[0].signals, '2');
});

test('countSignals counts independent signals and never exceeds 4', () => {
  assert.equal(countSignals({ sources: '', sector: '' }), 0);
  assert.equal(
    countSignals({ sources: 'ats-employers;ats-employers:board;github-orgs;directories', sector: '62.01Z X' }),
    4,
  );
  assert.equal(countSignals({ sources: 'ats-employers', sector: '47.11A Commerce' }), 0);
});

test('size_band keeps the latest value that is not unknown', () => {
  const first = merge([], [rec({ sizeBand: '20-49' })]).rows;
  const second = merge(first, [rec({ sizeBand: '?' })]).rows;
  assert.equal(second[0].size_band, '20-49');
  const third = merge(second, [rec({ sizeBand: '50-99' })]).rows;
  assert.equal(third[0].size_band, '50-99');
});

test('notes and columns added by later stages are untouched', () => {
  const existing = [{ key: 'acme', name: 'Acme', aliases: '', sites: 'Colmar:A', country: 'FR', sector: '', size_band: '?', signals: '0',
    sources: 'sirene', first_seen: '2026-01-01', last_seen: '2026-01-01', portals_ref: '—', notes: 'met at a fair', stage: 'enriched' }];
  const { rows } = merge(existing, [rec()]);
  assert.equal(rows[0].notes, 'met at a fair');
  assert.equal(rows[0].stage, 'enriched');
  assert.equal(rows[0].first_seen, '2026-01-01');
  assert.equal(rows[0].last_seen, TODAY);
});

test('merging the same records twice creates nothing new', () => {
  const records = [rec({ name: 'Acme SAS' }), rec({ name: 'Beta AG', country: 'CH', sites: [{ place: 'Basel', zone: 'B', country: 'CH' }] })];
  const once = merge([], records);
  const twice = merge(once.rows, records);
  assert.deepEqual(twice.newKeys, []);
  assert.deepEqual(twice.knownKeys.sort(), ['acme', 'beta']);
  assert.equal(twice.rows.length, 2);
  assert.deepEqual(twice.rows.map((r) => r.first_seen), once.rows.map((r) => r.first_seen));
});

test('a portals.yml entry fills portals_ref only while it is empty', () => {
  const portalsNames = new Map([['acme', 'Acme Corp']]);
  const { rows } = merge([], [rec()], { portalsNames });
  assert.equal(rows[0].portals_ref, 'Acme Corp');
  rows[0].portals_ref = 'Hand Set';
  assert.equal(merge(rows, [rec()], { portalsNames }).rows[0].portals_ref, 'Hand Set');
});
