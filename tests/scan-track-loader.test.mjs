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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));

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

test('real portals.yml: 99 companies eligible for track a, 30 for track b, 99 for track c (eligibility ignores enabled)', () => {
  const tracks = parseTracks(portals);
  const byId = Object.fromEntries(tracks.map(t => [t.id, t]));
  const companies = portals.tracked_companies;
  assert.strictEqual(companies.filter(c => isEligible(byId.a, c)).length, 99);
  assert.strictEqual(companies.filter(c => isEligible(byId.b, c)).length, 30);
  assert.strictEqual(companies.filter(c => isEligible(byId.c, c)).length, 99);
});
