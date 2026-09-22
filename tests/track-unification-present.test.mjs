// tests/track-unification-present.test.mjs — revert tripwire (#track-unification,
// R15). `scan.mjs` is auto-updatable System Layer (AGENTS.md), and
// `update-system.mjs apply` has already silently reverted a root .mjs file
// once in this repo's history (7f2e40e removed 52 lines of browser-extract.mjs;
// 43e884c restored them). If scan.mjs were reverted, portals.yml's tracks map
// would be silently ignored, the flat Track-A blocks would keep working, and
// Tracks B and C would simply vanish — indistinguishable from a quiet week.
// This test is the loud signal that makes that impossible to miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTracks, isEligible, mergeLocationHints, trackAdmits } from '../scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

test('portals.yml parses with a non-empty tracks map', () => {
  const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));
  assert.ok(portals.tracks && typeof portals.tracks === 'object');
  assert.ok(Object.keys(portals.tracks).length > 0, 'tracks map must not be empty');
});

test('scan.mjs still exports the track-unification functions and they work end to end', () => {
  assert.strictEqual(typeof parseTracks, 'function');
  assert.strictEqual(typeof isEligible, 'function');
  assert.strictEqual(typeof mergeLocationHints, 'function');
  assert.strictEqual(typeof trackAdmits, 'function');

  const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));
  const tracks = parseTracks(portals);
  assert.ok(tracks.length >= 1, 'parseTracks must return at least one track on the real portals.yml');
  assert.ok(tracks.some(t => t.id === 'b'), 'Track B must still be present — a hardcoded-roster revert would silently drop it');
  assert.ok(tracks.some(t => t.id === 'c'), 'Track C must still be present — a hardcoded-roster revert would silently drop it');
});
