// tests/portals-tracks-schema.test.mjs — shape contract for the committed
// fixture tests/fixtures/portals-tracks.yml, which scan-track-loader.test.mjs
// depends on. It used to read the user-layer portals.yml and deep-compare it
// against a snapshot frozen before the 2026-09-21 track unification; that
// proved the one-time move but failed on every later edit of the user's own
// config. What stays is the shape the loader tests need: tracks a, b, c, one
// tagged lane backed by at least one company, and the shared location_filter
// alias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const portals = yaml.load(readFileSync(join(__dirname, 'fixtures/portals-tracks.yml'), 'utf8'));

test('fixture has a non-empty tracks map with exactly a, b, c', () => {
  assert.ok(portals.tracks, 'fixture must have a top-level tracks key');
  assert.deepStrictEqual(Object.keys(portals.tracks).sort(), ['a', 'b', 'c']);
});

test('each track declares a valid scope', () => {
  assert.strictEqual(portals.tracks.a.scope, 'all');
  assert.strictEqual(portals.tracks.c.scope, 'all');
  assert.strictEqual(portals.tracks.b.scope, 'tagged');
  assert.strictEqual(portals.tracks.b.tag, 'trackb_whitelisted');
});

test('tracks.a and tracks.c share the same location_filter object (alias, not a copy)', () => {
  assert.strictEqual(portals.tracks.a.location_filter, portals.tracks.c.location_filter);
  assert.strictEqual(portals.tracks.a.location_filter, portals.location_filter);
});

test('every scope:tagged track\'s tag matches at least one tracked_companies entry', () => {
  for (const [id, track] of Object.entries(portals.tracks)) {
    if (track.scope !== 'tagged') continue;
    const matches = portals.tracked_companies.filter(c => c[track.tag] === true).length;
    assert.ok(matches > 0, `tracks.${id}'s tag "${track.tag}" matches 0 tracked_companies entries`);
  }
});
