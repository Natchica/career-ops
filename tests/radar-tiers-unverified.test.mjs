import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, hasBoard, isUnverified, loadTierRules } from '../radar/tiers.mjs';
import { RadarConfigError } from '../radar/zones.mjs';

const codeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(codeRoot, 'templates', 'radar-tiers.yml'), 'utf-8');

function rulesWith(extra, base = template) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-unverified-'));
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'radar-tiers.yml'), `${base}\n${extra}\n`);
  return { dataRoot, load: () => loadTierRules({ dataRoot, codeRoot }) };
}

const rules = loadTierRules({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-unverified-none-')), codeRoot });
const prospect = (over = {}) => ({
  key: 'acme', name: 'Acme', sources: 'github-orgs', aliases: '#github:acme', sites: 'Basel:B', country: 'CH',
  sector: '', size_band: '?', signals: '1', portals_ref: '—', tier_override: '', ...over,
});
const run = (over, r = rules) => classify(prospect(over), r);

test('a GitHub-only Prospect with one signal is capped at tier 2 with the exact reason', () => {
  const r = run({});
  assert.deepEqual([r.tier, r.reason], ['2', 'tier 2: unverified employer (github-orgs only); zone B, CH, 1 signal; size ?; no NAF code']);
});

test('a register id, a board or a register source keeps tier 1', () => {
  assert.equal(run({ aliases: '#uid:CHE111111111' }).tier, '1');
  assert.equal(run({ aliases: '#siren:123456789' }).tier, '1');
  assert.equal(run({ portals_ref: 'acme-board' }).tier, '1');
  assert.equal(run({ sources: 'github-orgs;ats-employers:board' }).tier, '1');
  assert.equal(run({ sources: 'github-orgs;zefix' }).tier, '1');
});

test('empty sources is not unverified', () => {
  assert.equal(isUnverified(prospect({ sources: '' }), rules), false);
  assert.equal(run({ sources: '' }).tier, '1');
});

test('hasBoard reads portals_ref and the board token', () => {
  assert.equal(hasBoard({ portals_ref: '—', sources: 'github-orgs' }), false);
  assert.equal(hasBoard({ portals_ref: '', sources: '' }), false);
  assert.equal(hasBoard({ portals_ref: 'x', sources: '' }), true);
  assert.equal(hasBoard({ portals_ref: '—', sources: 'zefix; ats-employers:board' }), true);
});

for (const [name, label] of [
  ['Boeva Lab, ETH Zurich', 'ETH Zurich'],
  ['Computer Graphics Group, University of Bern', 'university'],
  ['Université de Bâle', 'university'],
  ['Friedrich Miescher Institute for Biomedical Research', 'institute'],
]) {
  test(`non-employer: ${name}`, () => {
    const r = run({ name });
    assert.deepEqual([r.tier, r.reason], ['out', `out non-employer: ${label}`]);
  });
}

test('a non-employer match through an alias puts the row out', () => {
  const r = run({ name: 'Boeva', aliases: '#github:boeva;Boeva Lab at EPFL' });
  assert.deepEqual([r.tier, r.reason], ['out', 'out non-employer: EPFL']);
});

test('real companies with group, lab or ethics in the name stay at tier 2', () => {
  for (const name of ['MCH Group AG', 'Validity Labs', 'Knowledge Lab AG', 'Quantum Ethics']) {
    assert.equal(run({ name }).tier, '2', name);
  }
});

test('a verified employer is never put out as a non-employer', () => {
  const r = run({ name: 'Institute of Things AG', sources: 'zefix;zefix:software', aliases: '#uid:CHE111111111' });
  assert.equal(r.tier, '1');
});

test('absent keys: defaults apply and unverified_sources [] restores tier 1', () => {
  assert.deepEqual(rules.unverifiedSources, ['github-orgs']);
  const bare = template.replace(/^unverified_sources:.*$/m, '').replace(/^ {2}non_employer_patterns:[\s\S]*?(?=^\S)/m, '');
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-bare-'));
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'radar-tiers.yml'), bare);
  const loaded = loadTierRules({ dataRoot, codeRoot });
  assert.deepEqual(loaded.nonEmployer, []);
  assert.deepEqual(loaded.unverifiedSources, ['github-orgs']);
  assert.equal(run({ name: 'Boeva Lab, ETH Zurich' }, loaded).tier, '2');
  const off = rulesWith('unverified_sources: []', template.replace(/^unverified_sources:.*$/m, '')).load();
  const r = run({}, off);
  assert.deepEqual([r.tier, r.reason], ['1', 'tier 1: zone B, CH, 1 signal; size ?; no NAF code']);
});

test('a pattern that does not compile and a scalar unverified_sources are config errors', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'radar-badpat-'));
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  const withPattern = template.replace('  size_bands: ["1-2", "3-5"]', '  size_bands: ["1-2", "3-5"]\n  non_employer_patterns:\n    - { pattern: \'(\', label: bad }');
  writeFileSync(join(dataRoot, 'config', 'radar-tiers.yml'), withPattern);
  assert.throws(() => loadTierRules({ dataRoot, codeRoot }), (e) => e instanceof RadarConfigError && /radar-tiers\.yml/.test(e.message));
  assert.throws(() => rulesWith('unverified_sources: github-orgs').load(), (e) => e instanceof RadarConfigError && /radar-tiers\.yml/.test(e.message));
});

test('the trace lists non-employer after blacklist and unverified after tier', () => {
  const r = run({});
  assert.deepEqual(r.trace.map((t) => t.rule), ['floor', 'blacklist', 'non-employer', 'sector', 'size', 'zone', 'tier', 'unverified']);
  assert.equal(r.trace.at(-1).result, '2');
  assert.equal(run({ aliases: '#uid:CHE111111111' }).trace.at(-1).result, 'skipped');
});

test('tier_override wins and records the capped rule result', () => {
  const r = run({ tier_override: '1' });
  assert.equal(r.tier, '1');
  assert.match(r.reason, /rules: 2, tier 2: unverified employer/);
});
