import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadZoneTable, resolveZone } from '../radar/zones.mjs';

const CODE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function shippedTable() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-zones-'));
  return loadZoneTable({ dataRoot, codeRoot: CODE_ROOT });
}

test('postcode resolves to its commute zone', () => {
  const t = shippedTable();
  assert.equal(resolveZone(t, { postcode: '68000' }).zone, 'A');
  assert.equal(resolveZone(t, { postcode: '4051' }).zone, 'B');
  assert.equal(resolveZone(t, { postcode: '8004' }).zone, 'C');
  assert.equal(resolveZone(t, { postcode: '6300' }).zone, 'D');
});

test('a postcode outside every zone is reported as out', () => {
  const t = shippedTable();
  const r = resolveZone(t, { postcode: '1700' });
  assert.equal(r.zone, null);
  assert.equal(r.reason, 'out');
  assert.equal(resolveZone(t, { postcode: '75001' }).reason, 'out');
});

test('free text from scan history resolves to in-zone sites', async () => {
  const { resolveFreeText } = await import('../radar/zones.mjs');
  const t = shippedTable();
  const zones = (text) => resolveFreeText(t, text).map((s) => `${s.place}:${s.zone}`);
  assert.deepEqual(zones('STRASBOURG (67)'), ['Strasbourg:B']);
  assert.deepEqual(zones('Switzerland - Zürich'), ['Zurich:C']);
  assert.deepEqual(zones('Schweiz - Zürich'), ['Zurich:C']);
  assert.deepEqual(zones('Basel · Remote'), ['Basel:B']);
  assert.deepEqual(zones('Zurich, Switzerland'), ['Zurich:C']);
  assert.deepEqual(zones('Remote'), []);
  assert.deepEqual(zones('Paris, France'), []);
});

test('bare Freiburg is the German city, Freiburg in Switzerland is out', async () => {
  const { resolveFreeText } = await import('../radar/zones.mjs');
  const t = shippedTable();
  assert.deepEqual(resolveFreeText(t, 'Freiburg').map((s) => `${s.country}:${s.zone}`), ['DE:B']);
  assert.deepEqual(resolveFreeText(t, 'Freiburg, Switzerland'), []);
});

test('an ambiguous bare name is never guessed', () => {
  const t = shippedTable();
  assert.equal(resolveZone(t, { place: 'Baden' }).reason, 'ambiguous');
  assert.equal(resolveZone(t, { place: 'Baden', country: 'CH' }).zone, 'C');
});

test('a user override replaces the shipped table', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-zones-ovr-'));
  mkdirSync(join(dataRoot, 'config'));
  writeFileSync(
    join(dataRoot, 'config', 'radar-zones.yml'),
    'version: 1\nplaces:\n  - { zone: D, country: FR, name: Metz, postcodes: ["57000"] }\n',
  );
  const t = loadZoneTable({ dataRoot, codeRoot: CODE_ROOT });
  assert.equal(resolveZone(t, { postcode: '57000' }).zone, 'D');
  assert.equal(resolveZone(t, { postcode: '68000' }).reason, 'out');
});

test('a malformed override throws instead of falling back to the template', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { RadarConfigError } = await import('../radar/zones.mjs');
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-zones-bad-'));
  mkdirSync(join(dataRoot, 'config'));
  writeFileSync(join(dataRoot, 'config', 'radar-zones.yml'), 'places: [unclosed\n');
  assert.throws(() => loadZoneTable({ dataRoot, codeRoot: CODE_ROOT }), RadarConfigError);
  writeFileSync(join(dataRoot, 'config', 'radar-zones.yml'), 'version: 1\nplaces:\n  - { zone: Z, country: FR, name: X }\n');
  assert.throws(() => loadZoneTable({ dataRoot, codeRoot: CODE_ROOT }), /bad zone/);
});
