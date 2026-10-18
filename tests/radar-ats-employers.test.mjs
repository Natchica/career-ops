import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import source from '../radar/sources/ats-employers.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'radar', 'scan-history.tsv');

async function collect(ctx) {
  const out = [];
  for await (const record of source.fetch(ctx)) out.push(record);
  return out;
}

test('declares itself as a zero-auth ATS-family source', () => {
  assert.equal(source.id, 'ats-employers');
  assert.equal(source.family, 'ats');
  assert.equal(source.auth.kind, 'none');
});

test('emits one record per company and distinct location, skipping blank companies', async () => {
  const records = await collect({ historyPath: FIXTURE });
  assert.deepEqual(
    records.map((r) => [r.name, r.locationText]),
    [
      ['Acme AG', 'Basel, Switzerland'],
      ['Acme AG', 'Zurich, Switzerland'],
      ['Beta SAS', 'STRASBOURG (67)'],
      ['Gamma GmbH', 'Remote'],
      ['Delta', ''],
    ],
  );
});

test('board evidence comes from api and full portals, per company', async () => {
  const records = await collect({ historyPath: FIXTURE });
  const flag = Object.fromEntries(records.map((r) => [r.name, r.boardSignal]));
  assert.equal(flag['Acme AG'], true);
  assert.equal(flag['Beta SAS'], false);
  assert.equal(flag['Gamma GmbH'], true);
  assert.ok(records.every((r) => r.sourceId === 'ats-employers'));
  assert.equal(records[0].evidence, 'scan-history:greenhouse-api');
});

test('a missing history file is an error naming the path', async () => {
  await assert.rejects(collect({ historyPath: '/nonexistent/scan-history.tsv' }), /scan-history\.tsv/);
});
