// tests/scan-multi-track-admit.test.mjs — trackAdmits() is the pure per-track
// admission decision (#track-unification, 2026-09-21): eligible (isEligible)
// AND clears that track's own title/location/salary/content chain. The live
// scan loop calls it once per (track, posting) pair and unions the admitting
// track ids into job.tracks; this test proves the decision itself, using the
// 6 corpus titles admitted by BOTH tracks a and c (frozen in
// tests/fixtures/track-admit-baseline.json) as the multi-track fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTracks, trackAdmits } from '../scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8'));
const tracks = parseTracks(portals);
const byId = Object.fromEntries(tracks.map(t => [t.id, t]));

// An untagged (no trackb_whitelisted) company, on-site somewhere both a and
// c's location_filter allow.
const company = { name: 'Acme', careers_url: 'https://example.com' };

test('a posting matched by both a and c yields both ids, one entry each, no duplicates', () => {
  const job = { title: 'Backend Compiler Engineer', location: 'Zurich', salary: null, description: '' };
  const matched = tracks.filter(t => trackAdmits(t, company, job)).map(t => t.id);
  assert.deepStrictEqual(matched.sort(), ['a', 'c']);
});

test('a posting admitted by 0 tracks (fails every track\'s title filter)', () => {
  const job = { title: 'Executive Assistant to the CEO', location: 'Zurich', salary: null, description: '' };
  const matched = tracks.filter(t => trackAdmits(t, company, job)).map(t => t.id);
  assert.deepStrictEqual(matched, []);
});

test('track b never admits a posting at an untagged company, even with a b-shaped title', () => {
  const job = { title: 'Junior Software Engineer', location: 'Zurich', salary: { min: 90000, currency: 'CHF' }, description: '' };
  assert.strictEqual(trackAdmits(byId.b, company, job), false);
});

test('track b admits the same b-shaped title at a trackb_whitelisted company', () => {
  const taggedCompany = { name: 'Novartis', trackb_whitelisted: true };
  const job = { title: 'Junior Software Engineer', location: 'Zurich', salary: { min: 90000, currency: 'CHF' }, description: '' };
  assert.strictEqual(trackAdmits(byId.b, taggedCompany, job), true);
});

test('all 6 frozen a∩c corpus titles are admitted by both a and c at an untagged company', () => {
  const baseline = JSON.parse(readFileSync(join(__dirname, 'fixtures/track-admit-baseline.json'), 'utf8'));
  const bothTitles = baseline.a.filter(t => baseline.c.includes(t));
  assert.strictEqual(bothTitles.length, 6);
  for (const title of bothTitles) {
    const job = { title, location: 'Zurich', salary: null, description: '' };
    assert.strictEqual(trackAdmits(byId.a, company, job), true, `track a should admit "${title}"`);
    assert.strictEqual(trackAdmits(byId.c, company, job), true, `track c should admit "${title}"`);
  }
});
