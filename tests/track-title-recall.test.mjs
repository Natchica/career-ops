// tests/track-title-recall.test.mjs — replays the 663-title corpus at
// tests/fixtures/title-recall-corpus.json through each track's real
// title_filter (as loaded from the merged portals.yml), and asserts the
// admit sets exactly match tests/fixtures/track-admit-baseline.json, frozen
// from the reconciled pre-merge config on 2026-09-21.
//
// This is the Tier-2 proof from the track-unification plan: the corpus's own
// `titles` array is being used here as a plain title *list* against the real
// portals.yml filters, which is a different use of the fixture than its
// original per-title `matches` field (that field encodes recall against the
// corpus's own small embedded title_filter, not against portals.yml).
//
// The 6 titles admitted by BOTH a and c are the multi-track provenance-combine
// fixture: proof, available offline, that a posting can legitimately clear two
// independent tracks at once (scan.mjs must then emit one pipeline.md line
// with a combined track: A,C segment, not two lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { buildTitleFilter } from '../title-keywords.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const corpus = JSON.parse(readFileSync(join(__dirname, 'fixtures/title-recall-corpus.json'), 'utf8'));
const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures/track-admit-baseline.json'), 'utf8'));
const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));
const titles = corpus.titles.map(t => t.title);

const filters = {
  a: buildTitleFilter(portals.tracks.a.title_filter),
  b: buildTitleFilter(portals.tracks.b.title_filter),
  c: buildTitleFilter(portals.tracks.c.title_filter),
};

test('track a admits exactly 335 of 663 corpus titles, matching the frozen set', () => {
  const admits = titles.filter(t => filters.a(t)).sort();
  assert.strictEqual(admits.length, 335);
  assert.deepStrictEqual(admits, baseline.a);
});

test('track b admits exactly 3 of 663 corpus titles, matching the frozen set', () => {
  const admits = titles.filter(t => filters.b(t)).sort();
  assert.strictEqual(admits.length, 3);
  assert.deepStrictEqual(admits, baseline.b);
});

test('track c admits exactly 8 of 663 corpus titles, matching the frozen set', () => {
  const admits = titles.filter(t => filters.c(t)).sort();
  assert.strictEqual(admits.length, 8);
  assert.deepStrictEqual(admits, baseline.c);
});

test('exactly 6 titles are admitted by both a and c (the multi-track provenance fixture)', () => {
  const admitsA = new Set(titles.filter(t => filters.a(t)));
  const admitsC = new Set(titles.filter(t => filters.c(t)));
  const both = [...admitsA].filter(t => admitsC.has(t)).sort();
  assert.strictEqual(both.length, 6);
  assert.deepStrictEqual(both, [
    'Backend Compiler Engineer',
    'Lead Rust Engineer, Async VM',
    'Senior Backend Software Engineer - Agent Platform',
    'Senior Compiler Engineer - Backend GPU',
    'Senior Performance Engineer',
    'Sr. Performance Engineer, Trading Infrastructure',
  ]);
});
