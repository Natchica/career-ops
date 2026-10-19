import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compareProspects, loadTierRules } from '../radar/tiers.mjs';
import { RadarConfigError } from '../radar/zones.mjs';

const codeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(codeRoot, 'templates', 'radar-tiers.yml'), 'utf-8');

function rulesWith(extra) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-focus-'));
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'radar-tiers.yml'), `${template}\n${extra}\n`);
  return { dataRoot, load: () => loadTierRules({ dataRoot, codeRoot }) };
}

const focused = rulesWith('focus_country: CH').load();
const prospect = (over = {}) => ({
  key: 'acme', name: 'Acme', aliases: '', sites: 'Basel:B', country: 'CH', sector: '62.01Z', size_band: '10-19',
  signals: '1', tier_override: '', ...over,
});
const run = (over) => classify(prospect(over), focused);

test('the shipped template has no focus, so the default behaviour is unchanged', () => {
  const plain = loadTierRules({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-nofocus-')), codeRoot });
  assert.equal(plain.focusCountry, null);
});

test('focus_country is loaded and builds the set of places in that country', () => {
  assert.equal(focused.focusCountry, 'CH');
  assert.ok(focused.focusPlaces.has('basel'));
  assert.ok(focused.focusPlaces.has('zug'));
  assert.ok(!focused.focusPlaces.has('colmar'));
});

test('an unknown focus country is rejected', () => {
  assert.throws(() => rulesWith('focus_country: XX').load(), RadarConfigError);
});

test('nearness is measured from the best Swiss site, ignoring French ones', () => {
  const r = run({ sites: 'Mulhouse:A;Zug:D' });
  assert.equal(r.tier, '1');
  assert.equal(r.reason, 'tier 1: zone D, CH, 1 signal');
});

test('a Prospect with no Swiss site is tier 3 and says so', () => {
  const r = run({ sites: 'Colmar:A', country: 'FR' });
  assert.deepEqual([r.tier, r.reason], ['3', 'tier 3: no CH site']);
});

test('a Swiss site without a signal is tier 2', () => {
  const r = run({ sites: 'Basel:B', signals: '0' });
  assert.deepEqual([r.tier, r.reason], ['2', 'tier 2: zone B, CH, 0 signals']);
});

test('hard-outs still win over the focus', () => {
  assert.equal(run({ sector: '56.10A' }).tier, 'out');
  assert.equal(run({ size_band: '1-2' }).tier, 'out');
});

test('Swiss Prospects sort Basel, then Zurich, then Zug, whatever French sites they also have', () => {
  const rows = [
    prospect({ key: 'zug', sites: 'Zug:D' }),
    prospect({ key: 'zurich', sites: 'Zurich:C' }),
    prospect({ key: 'basel-mulhouse', sites: 'Mulhouse:A;Basel:B' }),
  ];
  const sorted = [...rows].sort((a, b) => compareProspects(a, b, focused)).map((p) => p.key);
  assert.deepEqual(sorted, ['basel-mulhouse', 'zurich', 'zug']);
});
