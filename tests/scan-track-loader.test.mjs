// tests/scan-track-loader.test.mjs — parseTracks()/isEligible() are the ONE
// place track structure is interpreted (#track-unification, 2026-09-21). Every
// other consumer sees a plain array and never reads config.tracks directly or
// branches on a literal track id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTracks, isEligible } from '../scan.mjs';

// Cases run against tests/fixtures/portals-tracks.yml, never the user-layer
// portals.yml: that file is gitignored and changes whenever the user edits
// their search, so a count read from it asserts nothing about this code.
const __dirname = dirname(fileURLToPath(import.meta.url));
const portals = yaml.load(readFileSync(join(__dirname, 'fixtures/portals-tracks.yml'), 'utf8'));

test('parseTracks returns 3 rows in declaration order with the right scope/tag', () => {
  const tracks = parseTracks(portals);
  assert.strictEqual(tracks.length, 3);
  assert.deepStrictEqual(tracks.map(t => t.id), ['a', 'b', 'c']);
  assert.strictEqual(tracks[0].scope, 'all');
  assert.strictEqual(tracks[0].tag, null);
  assert.strictEqual(tracks[1].scope, 'tagged');
  assert.strictEqual(tracks[1].tag, 'trackb_whitelisted');
  assert.strictEqual(tracks[2].scope, 'all');
  assert.strictEqual(tracks[2].tag, null);
});

test('parseTracks synthesizes a single implicit track a from the flat schema when `tracks` is absent entirely (backward compat)', () => {
  const legacy = parseTracks({ title_filter: { positive: ['Engineer'] } });
  assert.strictEqual(legacy.length, 1);
  assert.strictEqual(legacy[0].id, 'a');
  assert.strictEqual(legacy[0].scope, 'all');
  assert.strictEqual(legacy[0].titleFilter('Software Engineer'), true);
});

test('parseTracks throws when `tracks` is present but empty (real misconfiguration)', () => {
  assert.throws(() => parseTracks({ tracks: {} }), /tracks/);
});

test('parseTracks throws on an invalid scope', () => {
  assert.throws(() => parseTracks({ tracks: { x: { scope: 'sometimes' } } }), /scope/);
  assert.throws(() => parseTracks({ tracks: { x: {} } }), /scope/);
});

test('parseTracks throws on scope: tagged with no tag', () => {
  assert.throws(() => parseTracks({ tracks: { x: { scope: 'tagged' } } }), /tag/);
  assert.throws(() => parseTracks({ tracks: { x: { scope: 'tagged', tag: '' } } }), /tag/);
});

test('isEligible: scope all is always eligible regardless of company', () => {
  const track = { scope: 'all', tag: null };
  assert.strictEqual(isEligible(track, {}), true);
  assert.strictEqual(isEligible(track, { trackb_whitelisted: false }), true);
});

test('isEligible: scope tagged requires the exact boolean true on the named field', () => {
  const track = { scope: 'tagged', tag: 'trackb_whitelisted' };
  assert.strictEqual(isEligible(track, { trackb_whitelisted: true }), true);
  assert.strictEqual(isEligible(track, { trackb_whitelisted: false }), false);
  assert.strictEqual(isEligible(track, {}), false);
  // Strict-true rejection: a hand-edited string/number must not silently
  // widen a trust-vetted lane.
  assert.strictEqual(isEligible(track, { trackb_whitelisted: 'true' }), false);
  assert.strictEqual(isEligible(track, { trackb_whitelisted: 1 }), false);
  assert.strictEqual(isEligible(track, { trackb_whitelisted: 'yes' }), false);
});

test('fixture registry: 6 eligible for track a, 2 for track b, 6 for track c (eligibility ignores enabled; only boolean true counts)', () => {
  const byId = Object.fromEntries(parseTracks(portals).map(t => [t.id, t]));
  const eligible = (id) => portals.tracked_companies.filter(c => isEligible(byId[id], c)).map(c => c.name);
  assert.strictEqual(eligible('a').length, 6);
  assert.deepStrictEqual(eligible('b'), ['Alpha Tagged', 'Beta Tagged Disabled']);
  assert.strictEqual(eligible('c').length, 6);
});

test('legacy-shape entry (name + careers_url only) is eligible for scope: all tracks, not for tagged', () => {
  const byId = Object.fromEntries(parseTracks(portals).map(t => [t.id, t]));
  const legacy = portals.tracked_companies.find(c => c.name === 'Zeta Legacy');
  assert.deepStrictEqual(Object.keys(legacy).sort(), ['careers_url', 'name']);
  assert.strictEqual(isEligible(byId.a, legacy), true);
  assert.strictEqual(isEligible(byId.b, legacy), false);
  assert.strictEqual(isEligible(byId.c, legacy), true);
});

test('removing the tracks map falls back to one implicit track a covering the whole registry', () => {
  const flat = { ...portals };
  delete flat.tracks;
  const legacy = parseTracks(flat);
  assert.deepStrictEqual(legacy.map(t => t.id), ['a']);
  assert.strictEqual(portals.tracked_companies.filter(c => isEligible(legacy[0], c)).length, 6);
});
