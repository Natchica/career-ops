import { test } from 'node:test';
import assert from 'node:assert/strict';
import source, { VETTING } from '../radar/sources/directories.mjs';

test('declares itself as a startup and cluster directory source with nothing enabled', () => {
  assert.equal(source.id, 'directories');
  assert.equal(source.family, 'directory');
  assert.equal(source.auth.kind, 'none');
  assert.match(source.disabled, /no vetted site/);
});

test('every candidate site carries a verdict, the date it was checked and a reason', () => {
  assert.ok(VETTING.length >= 5);
  for (const entry of VETTING) {
    assert.ok(entry.site && entry.checked && entry.note, `${entry.site} is documented`);
    assert.match(entry.checked, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['not-built', 'built'].includes(entry.verdict));
  }
});

test('no site is enabled until its robots.txt and terms were checked', () => {
  assert.equal(VETTING.filter((e) => e.verdict === 'built').length, 0);
  const names = VETTING.map((e) => e.site).join(' ');
  for (const site of ['BaselArea', 'Alsace Digitale', 'BioValley', 'FWTM', 'WSW']) assert.match(names, new RegExp(site));
});

test('an unreachable site is never read as permission', () => {
  const bio = VETTING.find((e) => /BioValley/.test(e.site));
  assert.equal(bio.verdict, 'not-built');
  assert.match(bio.note, /could not be checked|unreachable/i);
});

test('fetch yields nothing', async () => {
  const out = [];
  for await (const record of source.fetch({})) out.push(record);
  assert.deepEqual(out, []);
});
