import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTierRules } from '../radar/tiers.mjs';
import { RadarConfigError } from '../radar/zones.mjs';

const codeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = () => mkdtempSync(join(tmpdir(), 'radar-tiers-'));
const override = (dataRoot, text) => {
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'radar-tiers.yml'), text);
};

test('a missing override falls back to the shipped template', () => {
  const rules = loadTierRules({ dataRoot: sandbox(), codeRoot });
  assert.match(rules.source, /templates[\\/]radar-tiers\.yml$/);
  assert.equal(rules.version, 1);
});

test('a present override wins over the template', () => {
  const dataRoot = sandbox();
  override(dataRoot, `version: 1
hard_out: { floor: [], blacklist: true, divisions: [{ division: "56", label: restaurants }], size_bands: ["1-2"] }
pool_zones: [A, B]
tiers: [{ tier: 1, min_signals: 2 }, { tier: 2, min_signals: 0 }]
order: { zones: [A, B, C, D], countries: [[CH], [FR, DE]], size_bands: ["10000+", "5000-9999", "2000-4999", "1000-1999", "500-999", "250-499", "200-249", "100-199", "50-99", "20-49", "10-19", "?", "6-9", "3-5", "1-2"] }
`);
  const rules = loadTierRules({ dataRoot, codeRoot });
  assert.match(rules.source, /config[\\/]radar-tiers\.yml$/);
  assert.deepEqual(rules.poolZones, ['A', 'B']);
});

test('a malformed override is an error and never falls back', () => {
  const dataRoot = sandbox();
  override(dataRoot, 'version: [unclosed');
  assert.throws(() => loadTierRules({ dataRoot, codeRoot }), RadarConfigError);
});

const base = `version: 1
hard_out: { floor: [{ code: "25.40Z", label: weapons }], blacklist: true, divisions: [{ division: "56", label: restaurants }], size_bands: ["1-2"] }
pool_zones: [A, B, C, D]
tiers: [{ tier: 1, min_signals: 1 }, { tier: 2, min_signals: 0 }]
order: { zones: [A, B, C, D], countries: [[CH], [FR, DE]], size_bands: ["10000+", "5000-9999", "2000-4999", "1000-1999", "500-999", "250-499", "200-249", "100-199", "50-99", "20-49", "10-19", "?", "6-9", "3-5", "1-2"] }
`;
for (const [name, mutate] of [
  ['version 2', (t) => t.replace('version: 1', 'version: 2')],
  ['floor code 9200', (t) => t.replace('25.40Z', '9200')],
  ['duplicate size band', (t) => t.replace('"10000+", ', '"10000+", "10000+", ')],
  ['pool zone E', (t) => t.replace('[A, B, C, D]\ntiers', '[E]\ntiers')],
]) {
  test(`bad shape is rejected: ${name}`, () => {
    const dataRoot = sandbox();
    override(dataRoot, mutate(base));
    assert.throws(() => loadTierRules({ dataRoot, codeRoot }), RadarConfigError);
  });
}

// ---- classify -------------------------------------------------------------
import { classify } from '../radar/tiers.mjs';

const rules = loadTierRules({ dataRoot: sandbox(), codeRoot });
const prospect = (over = {}) => ({
  key: 'acme', name: 'Acme', aliases: '', sites: 'Colmar:A', country: 'FR', sector: '62.01Z', size_band: '10-19',
  signals: '1', tier_override: '', ...over,
});
const none = () => false;
const run = (over, opts = { isBlacklisted: none }) => classify(prospect(over), rules, opts);

test('hard-outs carry the exact reason', () => {
  assert.deepEqual([run({ sector: '92.00Z' }).tier, run({ sector: '92.00Z' }).reason], ['out', 'out floor: 92.00Z gambling and betting']);
  assert.equal(run({}, { isBlacklisted: () => true }).reason, 'out blacklist: Acme');
  assert.equal(run({ sector: '56.10A' }).reason, 'out sector: 56 restaurants');
  assert.equal(run({ size_band: '1-2' }).reason, 'out size: 1-2');
  assert.equal(run({ size_band: '3-5' }).tier, 'out');
});

test('sector outranks size when both would exclude', () => {
  assert.equal(run({ sector: '56.10A', size_band: '1-2' }).reason, 'out sector: 56 restaurants');
});

test('zone and signals pick the tier', () => {
  assert.equal(run({}).tier, '1');
  assert.equal(run({}).reason, 'tier 1: zone A, FR, 1 signal');
  assert.equal(run({ sites: 'Basel:B', signals: '0' }).tier, '2');
  assert.equal(run({ sites: 'Zurich:C', country: 'CH', sector: 'zefix-purpose:software', size_band: '?', signals: '1' }).tier, '1');
  assert.equal(run({ sites: 'Zug:D', country: 'CH', signals: '0' }).tier, '2');
});

test('best zone of several sites decides', () => {
  assert.match(run({ sites: 'Zug:D;Basel:B' }).reason, /zone B/);
});

test('an unknown size stays in its tier and is noted; empty sector is noted', () => {
  const r = run({ country: 'CH', sites: 'Basel:B', size_band: '?' });
  assert.equal(r.tier, '1');
  assert.match(r.reason, /; size \?$/);
  assert.match(run({ sector: '' }).reason, /; no NAF code$/);
});

test('no zone A-D is tier 3 unknown', () => {
  assert.deepEqual([run({ sites: '' }).tier, run({ sites: '' }).reason], ['3', 'unknown: no zone A-D']);
  assert.equal(run({ sites: 'Paris:X' }).tier, '3');
});

test('the trace lists every rule evaluated', () => {
  const r = run({});
  assert.deepEqual(r.trace.map((t) => t.rule), ['floor', 'blacklist', 'sector', 'size', 'zone', 'tier']);
});

test('tier_override wins and keeps the computed result in the reason', () => {
  const out = run({ tier_override: 'out' });
  assert.equal(out.tier, 'out');
  assert.equal(out.reason, 'override: out (rules: 1, tier 1: zone A, FR, 1 signal)');
  const forced = run({ tier_override: '1' }, { isBlacklisted: () => true });
  assert.equal(forced.tier, '1');
  assert.match(forced.reason, /rules: out, out blacklist: Acme/);
});

test('an invalid override is ignored and flagged', () => {
  const r = run({ tier_override: 'x' });
  assert.equal(r.tier, '1');
  assert.equal(r.invalidOverride, true);
  assert.equal(run({}).invalidOverride, false);
});

// ---- order ----------------------------------------------------------------
import { compareProspects, parseSpontaneous, formatSpontaneous } from '../radar/tiers.mjs';

const sorted = (rows) => [...rows].sort((a, b) => compareProspects(a, b, rules)).map((p) => p.key);

test('zone A before B even with fewer signals', () => {
  assert.deepEqual(sorted([prospect({ key: 'b', sites: 'Basel:B', signals: '2' }), prospect({ key: 'a', sites: 'Colmar:A', signals: '1' })]), ['a', 'b']);
});

test('inside a zone CH comes before FR, and FR ties with DE', () => {
  const rows = [
    prospect({ key: 'fr', country: 'FR', sites: 'Basel:B' }),
    prospect({ key: 'ch', country: 'CH', sites: 'Basel:B' }),
    prospect({ key: 'de', country: 'DE', sites: 'Basel:B' }),
  ];
  assert.equal(sorted(rows)[0], 'ch');
  assert.deepEqual(sorted(rows).slice(1), ['de', 'fr']);
});

test('more signals first, then larger size, with 10-19 > ? > 6-9', () => {
  assert.deepEqual(sorted([prospect({ key: 's1', signals: '1' }), prospect({ key: 's2', signals: '2' })]), ['s2', 's1']);
  const sizes = ['6-9', '?', '10-19'].map((size_band) => prospect({ key: size_band, size_band }));
  assert.deepEqual(sorted(sizes), ['10-19', '?', '6-9']);
});

test('an equal tuple is decided by key, and sorting is stable across runs', () => {
  const rows = [prospect({ key: 'z' }), prospect({ key: 'a' }), prospect({ key: 'm' })];
  assert.deepEqual(sorted(rows), ['a', 'm', 'z']);
  assert.deepEqual(sorted(rows.reverse()), ['a', 'm', 'z']);
});

// ---- spontaneous cell grammar ----------------------------------------------
test('spontaneous cells parse and round-trip', () => {
  assert.deepEqual(parseSpontaneous(''), { state: 'none' });
  const drafted = parseSpontaneous('drafted:2026-10-20');
  assert.deepEqual(drafted, { state: 'drafted', date: '2026-10-20' });
  assert.equal(formatSpontaneous(drafted), 'drafted:2026-10-20');
  const sent = parseSpontaneous('sent:2026-10-21:#123');
  assert.deepEqual(sent, { state: 'sent', date: '2026-10-21', tracker: 123 });
  assert.equal(formatSpontaneous(sent), 'sent:2026-10-21:#123');
});

test('a skipped reason keeps everything after the second colon', () => {
  const s = parseSpontaneous('skipped:2026-10-20:no info: none found');
  assert.deepEqual(s, { state: 'skipped', date: '2026-10-20', why: 'no info: none found' });
  assert.equal(formatSpontaneous(s), 'skipped:2026-10-20:no info: none found');
  assert.equal(formatSpontaneous({ state: 'skipped', date: '2026-10-20' }), 'skipped:2026-10-20');
});

test('malformed cells are invalid', () => {
  assert.equal(parseSpontaneous('sent:2026-10-21').state, 'invalid');
  assert.equal(parseSpontaneous('foo').state, 'invalid');
  assert.equal(parseSpontaneous('drafted:yesterday').state, 'invalid');
});
