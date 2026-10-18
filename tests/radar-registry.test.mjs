import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RADAR_COLUMNS, RadarRegistryError, registryPath,
  parseRegistry, serializeRegistry, readRegistry, writeRegistry,
} from '../radar/registry.mjs';
import { mergeRecords } from '../radar/identity.mjs';
import { buildCompanyCanonicalizer } from '../scan.mjs';

const sandbox = () => mkdtempSync(join(tmpdir(), 'radar-registry-'));
const row = (over = {}) => ({
  key: 'acme', name: 'Acme', aliases: '', sites: 'Colmar:A', country: 'FR', sector: '', size_band: '?', signals: '0',
  sources: 'sirene', first_seen: '2026-10-18', last_seen: '2026-10-18', portals_ref: '—', notes: '', ...over,
});

test('registry path sits under data/ of the resolved root', () => {
  assert.equal(registryPath('/r'), '/r/data/radar.tsv');
});

test('a registry round-trips by header name and keeps columns added by later stages', () => {
  const columns = [...RADAR_COLUMNS, 'stage'];
  const rows = [row({ stage: 'enriched', notes: 'met at a fair' })];
  const parsed = parseRegistry(serializeRegistry({ columns, rows }));
  assert.deepEqual(parsed.columns, columns);
  assert.deepEqual(parsed.rows, rows);
});

test('columns are addressed by header, so their order does not matter', () => {
  const text = 'name\tkey\tnotes\nAcme\tacme\thi\n';
  const { rows } = parseRegistry(text);
  assert.equal(rows[0].key, 'acme');
  assert.equal(rows[0].name, 'Acme');
  assert.equal(rows[0].notes, 'hi');
});

test('a header without key, a duplicate key and a short row are errors', () => {
  assert.throws(() => parseRegistry('name\tnotes\nAcme\thi\n'), RadarRegistryError);
  assert.throws(() => parseRegistry('key\tname\nacme\tA\nacme\tB\n'), /duplicate key "acme"/);
  assert.throws(() => parseRegistry('key\tname\nacme\n'), /line 2/);
});

test('spreadsheet formula cells survive the round trip', () => {
  const rows = [row({ name: '=SUM(1)', notes: "'+x" })];
  const parsed = parseRegistry(serializeRegistry({ columns: RADAR_COLUMNS, rows }));
  assert.equal(parsed.rows[0].name, '=SUM(1)');
  assert.equal(parsed.rows[0].notes, "'+x");
  assert.match(serializeRegistry({ columns: RADAR_COLUMNS, rows }), /'=SUM\(1\)/);
});

test('tabs and newlines inside a cell become spaces', () => {
  const text = serializeRegistry({ columns: RADAR_COLUMNS, rows: [row({ notes: 'a\tb\nc' })] });
  assert.equal(parseRegistry(text).rows[0].notes, 'a b c');
});

test('a missing file reads as an empty registry, a malformed one throws', () => {
  const dir = sandbox();
  const missing = readRegistry(join(dir, 'data', 'radar.tsv'));
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.rows, []);
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'radar.tsv'), 'name\nAcme\n');
  assert.throws(() => readRegistry(join(dir, 'data', 'radar.tsv')), RadarRegistryError);
});

test('a write creates the file and releases the lock', async () => {
  const dir = sandbox();
  const path = join(dir, 'data', 'radar.tsv');
  await writeRegistry(path, { columns: RADAR_COLUMNS, rows: [row()] });
  assert.equal(readRegistry(path).rows[0].key, 'acme');
  assert.equal(existsSync(`${path}.lock`), false);
});

test('a failed write leaves the previous file byte-identical and releases the lock', async () => {
  const dir = sandbox();
  const path = join(dir, 'data', 'radar.tsv');
  await writeRegistry(path, { columns: RADAR_COLUMNS, rows: [row()] });
  const before = readFileSync(path);
  const poisoned = { key: 'bad', toString() { throw new Error('boom'); } };
  await assert.rejects(writeRegistry(path, { columns: RADAR_COLUMNS, rows: [row({ name: poisoned })] }), /boom/);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(`${path}.lock`), false);
});

test('a held lock rejects with ELOCKED and a stale lock is taken over', async () => {
  const dir = sandbox();
  mkdirSync(join(dir, 'data'));
  const path = join(dir, 'data', 'radar.tsv');
  writeFileSync(`${path}.lock`, '1');
  await assert.rejects(writeRegistry(path, { columns: RADAR_COLUMNS, rows: [row()] }), (e) => e.code === 'ELOCKED');
  const old = new Date(Date.now() - 31 * 60 * 1000);
  utimesSync(`${path}.lock`, old, old);
  await writeRegistry(path, { columns: RADAR_COLUMNS, rows: [row()] });
  assert.equal(readRegistry(path).rows.length, 1);
});

test('50k rows parse, group and serialize in under 3 seconds', () => {
  const canon = buildCompanyCanonicalizer({});
  const records = Array.from({ length: 50_000 }, (_, i) => ({
    name: `Company ${i} SAS`, country: 'FR', sites: [{ place: 'Colmar', zone: 'A', country: 'FR' }], sourceId: 'sirene',
  }));
  const started = Date.now();
  const first = mergeRecords([], records, { canon, today: '2026-10-18', portalsNames: new Map() });
  const text = serializeRegistry({ columns: RADAR_COLUMNS, rows: first.rows });
  const parsed = parseRegistry(text);
  const second = mergeRecords(parsed.rows, records, { canon, today: '2026-10-19', portalsNames: new Map() });
  const ms = Date.now() - started;
  console.log(`radar 50k round: ${ms} ms`);
  assert.equal(second.newKeys.length, 0);
  assert.equal(second.rows.length, 50_000);
  assert.ok(ms < 3000, `took ${ms} ms`);
});
