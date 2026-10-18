import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRawCache } from '../radar/cache.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'radar-cache-'));
const records = [{ name: 'Acme', sourceId: 'sirene' }];

test('records are stored always and replayed only when the cache is switched on', () => {
  const dir = root();
  const off = makeRawCache({ root: dir, sourceId: 'sirene', useCache: false });
  off.set('68000', records);
  assert.equal(off.get('68000'), null);
  const on = makeRawCache({ root: dir, sourceId: 'sirene', useCache: true });
  assert.deepEqual(on.get('68000'), records);
});

test('a unit older than 24 hours is not replayed', () => {
  const dir = root();
  let now = 1_000_000;
  const cache = makeRawCache({ root: dir, sourceId: 'sirene', useCache: true, now: () => now });
  cache.set('68000', records);
  now += 23 * 3600 * 1000;
  assert.deepEqual(cache.get('68000'), records);
  now += 2 * 3600 * 1000;
  assert.equal(cache.get('68000'), null);
});

test('a missing or unreadable unit is a miss and never an error', () => {
  const dir = root();
  const cache = makeRawCache({ root: dir, sourceId: 'sirene', useCache: true });
  assert.equal(cache.get('99999'), null);
});

test('unit names cannot escape the cache directory', () => {
  const dir = root();
  const cache = makeRawCache({ root: dir, sourceId: 'sirene', useCache: true });
  cache.set('../../etc/passwd', records);
  const files = readdirSync(join(dir, 'data', 'cache', 'radar', 'sirene'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-z0-9._-]+\.json$/);
});
