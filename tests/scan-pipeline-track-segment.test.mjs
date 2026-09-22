// tests/scan-pipeline-track-segment.test.mjs — formatPipelineOffer()'s new
// `| track: A,C` provenance segment (#track-unification, 2026-09-21). A
// labeled trailing segment, not a positional cell, riding the same convention
// as `posted:`/trust/`note:` — so pipeline.md readers that index cells[0..2]
// and ignore the rest (rank-pipeline.mjs's parsePendingEntries,
// reconcile-pipeline.mjs's body.split('|')) are unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPipelineOffer } from '../scan.mjs';
import { parsePendingEntries } from '../rank-pipeline.mjs';

const base = {
  url: 'https://example.com/jobs/123',
  company: 'Acme',
  title: 'Runtime Engineer',
};

test('multi-track offer renders a comma-joined, uppercased track: segment', () => {
  const line = formatPipelineOffer({ ...base, tracks: ['a', 'c'] });
  assert.ok(line.endsWith('| track: A,C'), `expected line to end with track segment, got: ${line}`);
});

test('single-track offer renders one uppercased id', () => {
  const line = formatPipelineOffer({ ...base, tracks: ['b'] });
  assert.ok(line.endsWith('| track: B'), `expected line to end with track: B, got: ${line}`);
});

test('an offer with no tracks field formats byte-identically to before this feature', () => {
  const withTracks = formatPipelineOffer({ ...base, tracks: [] });
  const without = formatPipelineOffer({ ...base });
  assert.strictEqual(without, withTracks);
  assert.ok(!without.includes('track:'), 'no track: segment should appear when tracks is absent/empty');
});

test('the segment sits after trust and before note, preserving stable order', () => {
  const line = formatPipelineOffer({
    ...base,
    trustScore: 40,
    trustFlags: ['no_salary'],
    tracks: ['a'],
    note: 'flagged for review',
  });
  const trustIdx = line.indexOf('trust:');
  const trackIdx = line.indexOf('track:');
  const noteIdx = line.indexOf('note:');
  assert.ok(trustIdx > -1 && trackIdx > trustIdx, 'track: must come after trust:');
  assert.ok(noteIdx > trackIdx, 'note: must come after track:');
});

test('rank-pipeline.mjs still reads url/company/title correctly from a track-tagged line', () => {
  const line = formatPipelineOffer({ ...base, tracks: ['a', 'c'] });
  const text = `${line}\n`;
  const [entry] = parsePendingEntries(text);
  assert.strictEqual(entry.url, base.url);
  assert.strictEqual(entry.company, base.company);
  assert.strictEqual(entry.title, base.title);
});

test('reconcile-pipeline.mjs-style split still resolves company/role at parts[1]/[2] from a track-tagged line', () => {
  const line = formatPipelineOffer({ ...base, tracks: ['a', 'c'] });
  const body = line.replace(/^- \[ \] /, '');
  const parts = body.split('|').map(s => s.trim());
  assert.strictEqual(parts[1], base.company);
  assert.strictEqual(parts[2], base.title);
});
