import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCoverage } from '../radar/coverage.mjs';
import { loadZoneTable } from '../radar/zones.mjs';
import { buildCompanyCanonicalizer } from '../scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-cov-')), codeRoot: ROOT });
const canon = buildCompanyCanonicalizer({});

const history = (names, location = 'Basel, Switzerland') => names.map((name) => ({ name, locationText: location }));
const row = (key, sources = 'sirene') => ({ key, name: key, sources });
const cover = (over) => computeCoverage({ records: [], portalsNames: [], rows: [], table, canon, ...over });

test('recall is the share of in-zone baseline companies the radar holds', () => {
  const names = Array.from({ length: 10 }, (_, i) => `Company ${i}`);
  const rows = names.slice(0, 7).map((n) => row(n.toLowerCase()));
  const result = cover({ records: history(names), rows });
  assert.equal(result.baseline.size, 10);
  assert.equal(result.found, 7);
  assert.equal(result.recall_all, 0.7);
  assert.deepEqual(result.missing, ['Company 7', 'Company 8', 'Company 9']);
});

test('companies outside the zones or without a location are not in the baseline', () => {
  const records = [
    ...history(['Inzone AG']),
    { name: 'Remote Corp', locationText: 'Remote' },
    { name: 'Nowhere Ltd', locationText: '' },
    { name: 'Paris SAS', locationText: 'Paris, France' },
  ];
  const result = cover({ records, rows: [] });
  assert.equal(result.baseline.size, 1);
});

test('spelling and legal-form variants count as the same company', () => {
  const result = cover({ records: history(['ACME SAS']), rows: [row('acme')] });
  assert.equal(result.recall_all, 1);
});

test('a same-name collision key counts towards its base name', () => {
  const result = cover({ records: history(['Optimum']), rows: [row('optimum|FR|colmar')] });
  assert.equal(result.recall_all, 1);
});

test('registers alone are measured separately, since ats-employers is built from the same history', () => {
  const names = ['A One', 'B Two', 'C Three', 'D Four'];
  const rows = [
    row('a one', 'ats-employers'),
    row('b two', 'ats-employers;ats-employers:board'),
    row('c three', 'sirene'),
    row('d four', 'sirene;ats-employers'),
  ];
  const result = cover({ records: history(names), rows });
  assert.equal(result.recall_all, 1);
  assert.equal(result.recall_excluding_ats_employers, 0.5);
  assert.deepEqual(result.missing_excluding_ats_employers, ['A One', 'B Two']);
});

test('tracked portals are zoned through the history and the rest are reported as unzoned', () => {
  const records = history(['Tracked AG']);
  const result = cover({ records, portalsNames: ['Tracked AG', 'Mystery GmbH'], rows: [] });
  assert.equal(result.baseline.size, 1, 'Tracked AG enters the baseline once, not twice');
  assert.equal(result.baseline.unzoned, 1);
  assert.deepEqual(result.baseline.unzoned_names, ['Mystery GmbH']);
});

test('an empty baseline gives no recall instead of a misleading number', () => {
  const result = cover({});
  assert.equal(result.baseline.size, 0);
  assert.equal(result.recall_all, null);
  assert.equal(result.recall_excluding_ats_employers, null);
});

test('long lists of missing names are capped', () => {
  const names = Array.from({ length: 300 }, (_, i) => `Firm ${String(i).padStart(3, '0')}`);
  const result = cover({ records: history(names), rows: [] });
  assert.equal(result.missing.length, 200);
  assert.equal(result.missing_total, 300);
});
