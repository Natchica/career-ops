// tests/scan-location-hints-union.test.mjs — mergeLocationHints() unions
// always_allow/allow and intersects block/block_hard across every track
// eligible for a company (#track-unification, 2026-09-21). Union-then-
// intersect is the only combination that cannot make one track's geography
// unfetchable for another's benefit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTracks, mergeLocationHints } from '../scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));
const tracks = parseTracks(portals);

test('an untagged company (eligible for a+c, which alias the same list) merges to the same content', () => {
  // Tracks a and c are both scope: all and share the identical (aliased)
  // location_filter, so this exercises the multi-track union/intersect path
  // even though there is effectively only one distinct list to merge.
  const hints = mergeLocationHints(tracks, { name: 'X' });
  assert.deepStrictEqual(new Set(hints.allow), new Set(portals.tracks.a.location_filter.allow));
  assert.deepStrictEqual(new Set(hints.always_allow), new Set(portals.tracks.a.location_filter.always_allow));
  assert.deepStrictEqual(new Set(hints.block), new Set(portals.tracks.a.location_filter.block));
});

test('a B-tagged company gets union(allow)/intersect(block) across tracks a, b, c', () => {
  const company = { name: 'Novartis', trackb_whitelisted: true };
  const hints = mergeLocationHints(tracks, company);
  // B-only allow entry present (Bern), A-only allow entry present (Remote is
  // actually a "block" case below — pick an unambiguous allow-only city).
  assert.ok(hints.allow.includes('Bern'), 'B-only allow entry missing from union');
  assert.ok(hints.allow.includes('Remote'), 'A-only allow entry missing from union');
  // Remote is allowed by A but blocked by B — intersection of block must
  // exclude it (block is an AND of what every eligible track blocks), so it
  // must NOT appear in the merged block list, and it must still appear in
  // the merged allow list from A's side.
  assert.ok(!hints.block.includes('Remote'), 'block intersection wrongly narrowed by B\'s stricter list');
});

test('always_allow and allow are pure unions, never dropped by a stricter track', () => {
  const company = { name: 'Novartis', trackb_whitelisted: true };
  const hints = mergeLocationHints(tracks, company);
  for (const city of portals.tracks.a.location_filter.allow) {
    assert.ok(hints.allow.includes(city), `A's allow entry "${city}" dropped from the union`);
  }
  for (const city of portals.tracks.b.location_filter.allow) {
    assert.ok(hints.allow.includes(city), `B's allow entry "${city}" dropped from the union`);
  }
});

test('block/block_hard are pure intersections: an entry blocked by only one track is not blocked in the merge', () => {
  const company = { name: 'Novartis', trackb_whitelisted: true };
  const hints = mergeLocationHints(tracks, company);
  const aBlock = new Set(portals.tracks.a.location_filter.block);
  const bBlock = new Set(portals.tracks.b.location_filter.block);
  for (const entry of hints.block) {
    assert.ok(aBlock.has(entry) && bBlock.has(entry), `"${entry}" is in the merged block list but not blocked by every eligible track`);
  }
});
