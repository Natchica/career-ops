// tests/validate-portals-tracks.test.mjs — validate-portals.mjs's checks for
// the open-ended `tracks` map (#track-unification, 2026-09-21): absent
// entirely is valid (legacy flat-only schema); present but malformed is a
// loud error, never a silent skip that would read as "0 warnings, all fine".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePortalsConfig } from '../validate-portals.mjs';

const providerIds = new Set(['greenhouse', 'workday']);

test('tracks absent entirely is valid (legacy flat-only schema)', async () => {
  const { errors } = await validatePortalsConfig({ title_filter: { positive: ['Engineer'] } }, { providerIds });
  assert.strictEqual(errors.filter(e => e.path === 'tracks').length, 0);
});

test('tracks present but empty is an error', async () => {
  const { errors } = await validatePortalsConfig({ tracks: {} }, { providerIds });
  assert.ok(errors.some(e => e.path === 'tracks'), 'expected an error on the empty tracks map');
});

test('a track missing scope is an error naming tracks.<id>.scope', async () => {
  const { errors } = await validatePortalsConfig({ tracks: { a: {} } }, { providerIds });
  assert.ok(errors.some(e => e.path === 'tracks.a.scope'));
});

test('scope: tagged with no tag is an error naming tracks.<id>.tag', async () => {
  const { errors } = await validatePortalsConfig({ tracks: { b: { scope: 'tagged' } } }, { providerIds });
  assert.ok(errors.some(e => e.path === 'tracks.b.tag'));
});

test('an unknown key inside a track block is an error', async () => {
  const { errors } = await validatePortalsConfig({ tracks: { a: { scope: 'all', bogus_field: 1 } } }, { providerIds });
  assert.ok(errors.some(e => e.path === 'tracks.a.bogus_field'));
});

test('a non-string title_filter.positive entry inside a track is an error at the tracks.<id> path', async () => {
  const { errors } = await validatePortalsConfig({
    tracks: { b: { scope: 'tagged', tag: 'trackb_whitelisted', title_filter: { positive: [42] } } },
  }, { providerIds });
  assert.ok(errors.some(e => e.path === 'tracks.b.title_filter.positive[0]'));
});

test('a company field that looks like a track tag but matches no declared tag is a warning', async () => {
  const { warnings } = await validatePortalsConfig({
    tracks: { b: { scope: 'tagged', tag: 'trackb_whitelisted', title_filter: {} } },
    tracked_companies: [{ name: 'Acme', careers_url: 'https://acme.example.com', trackb_whitelist: true }],
  }, { providerIds });
  assert.ok(warnings.some(w => w.path.includes('trackb_whitelist') && w.message.includes('typo')));
});

test('a company field matching the real declared tag produces no warning', async () => {
  const { warnings } = await validatePortalsConfig({
    tracks: { b: { scope: 'tagged', tag: 'trackb_whitelisted', title_filter: {} } },
    tracked_companies: [{ name: 'Acme', careers_url: 'https://acme.example.com', trackb_whitelisted: true }],
  }, { providerIds });
  assert.strictEqual(warnings.filter(w => w.path.includes('trackb_whitelisted')).length, 0);
});

test('the real merged portals.yml and the shipped example template both still validate clean', async () => {
  const { execFileSync } = await import('node:child_process');
  const outExample = execFileSync(process.execPath, ['validate-portals.mjs', '--file', 'templates/portals.example.yml'], { encoding: 'utf8' });
  assert.match(outExample, /0 errors, 0 warnings/);
  const outReal = execFileSync(process.execPath, ['validate-portals.mjs'], { encoding: 'utf8' });
  assert.match(outReal, /0 errors, 0 warnings/);
});
