// tests/portals-tracks-schema.test.mjs — the track-unification merge (2026-09-21)
// folded portals.yml / portals-trackb.yml / portals-trackc.yml into one
// portals.yml with a shared tracked_companies registry and an open-ended
// tracks.<id> map. This is the Tier-1 proof from the plan: for a pure config
// *move*, deep-equality of each track's parsed block against the frozen
// pre-merge baseline is a stronger and cheaper proof than any behavioural
// test, because buildTitleFilter/buildLocationFilter/buildSalaryFilter are
// pure functions of their config — equal config implies equal predicate.
//
// tests/fixtures/track-config-baseline.json was generated from the 3
// *reconciled* old files (after the 11-company config backport, before the
// merge) and must never be regenerated from the merged file itself — that
// would make this test tautological.
//
// Registry arithmetic note: this test asserts 30 tagged entries, not the
// planning pass's predicted 27. Measured: Track B has 31 companies total: one
// (Roche) is disabled *because it fails the CHF 80k trust bar itself*
// ("disabled on evidence: ... below the CHF 80k bar") and correctly gets no
// tag; the other 3 disabled entries (Baloise, Bachem, Coop) are disabled only
// because their board is currently broken/unclaimed ("unvetted: ... worth
// revisiting") — the employer itself is still trust-vetted. Per the design's
// own stated principle ("enabled means scannable at all; a track's
// eligibility is its tag" — the two are orthogonal), those 3 keep the tag
// despite being disabled, so a future board fix does not also require
// remembering to re-add the tag. 31 - 1 = 30.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures/track-config-baseline.json'), 'utf8'));
const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));

test('portals.yml has a non-empty tracks map with exactly a, b, c', () => {
  assert.ok(portals.tracks, 'portals.yml must have a top-level tracks key');
  assert.deepStrictEqual(Object.keys(portals.tracks).sort(), ['a', 'b', 'c']);
});

test('each track declares a valid scope', () => {
  assert.strictEqual(portals.tracks.a.scope, 'all');
  assert.strictEqual(portals.tracks.c.scope, 'all');
  assert.strictEqual(portals.tracks.b.scope, 'tagged');
  assert.strictEqual(portals.tracks.b.tag, 'trackb_whitelisted');
});

for (const id of ['a', 'b', 'c']) {
  for (const key of Object.keys(baseline[id])) {
    test(`tracks.${id}.${key} is unchanged by the merge`, () => {
      assert.deepStrictEqual(portals.tracks[id][key], baseline[id][key]);
    });
  }
}

test('tracks.a and tracks.c share the same location_filter object (alias, not a copy)', () => {
  assert.strictEqual(portals.tracks.a.location_filter, portals.tracks.c.location_filter);
  assert.strictEqual(portals.tracks.a.location_filter, portals.location_filter);
});

test('tracked_companies registry: 99 unique entries, 86 enabled, 30 tagged trackb_whitelisted', () => {
  const companies = portals.tracked_companies;
  assert.strictEqual(companies.length, 99);
  assert.strictEqual(companies.filter(c => c.enabled !== false).length, 86);
  assert.strictEqual(companies.filter(c => c.trackb_whitelisted === true).length, 30);
});

test('every scope:tagged track\'s tag matches at least one tracked_companies entry', () => {
  const companies = portals.tracked_companies;
  for (const [id, track] of Object.entries(portals.tracks)) {
    if (track.scope !== 'tagged') continue;
    const matches = companies.filter(c => c[track.tag] === true).length;
    assert.ok(matches > 0, `tracks.${id}'s tag "${track.tag}" matches 0 tracked_companies entries`);
  }
});
