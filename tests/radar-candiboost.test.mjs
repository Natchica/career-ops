import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import source, { collectSpellings, promote } from '../radar/sources/candiboost.mjs';
import { formatCandidates } from '../radar/resolve.mjs';
import { loadZoneTable } from '../radar/zones.mjs';
import { parseRegistry } from '../radar/registry.mjs';
import {
  PENDING_COLUMNS, REGISTRY_COLUMNS, RESOLVED_COLUMNS, CandiboostTableError, parseTable, serializeTable,
} from '../lib/candiboost.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-candiboost-zones-')), codeRoot: ROOT });
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-candiboost-'));
  roots.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  return dir;
}
const pendingFile = (root) => join(root, 'data', 'candiboost-pending.tsv');
const sendsFile = (root) => join(root, 'data', 'candiboost.tsv');
const resolvedFile = (root) => join(root, 'data', 'candiboost-resolved.tsv');
const write = (path, columns, rows) => writeFileSync(path, serializeTable({ columns, rows }));
const writePending = (root, rows) => write(pendingFile(root), PENDING_COLUMNS, rows.map((r) => ({ first_seen: '2026-10-01', last_seen: '2026-10-02', ...r })));
const writeSends = (root, rows) => write(sendsFile(root), REGISTRY_COLUMNS, rows);
const writeResolved = (root, rows) => write(resolvedFile(root), RESOLVED_COLUMNS, rows.map(resolvedRow));
const readResolved = (root) => parseTable(readFileSync(resolvedFile(root), 'utf-8'), { key: 'company', columns: RESOLVED_COLUMNS });
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const resolvedRow = (over = {}) => ({
  company: 'X', domain: '', country: '', legal_name: '', entity_id: '', place: '', postcode: '', sector: '',
  size_band: '', verdict: 'unresolved', candidates: '', checked: '2026-10-20', ...over,
});
const resolvedAt = (company, over = {}) => resolvedRow({
  company, country: 'CH', legal_name: `${company} AG`, entity_id: 'uid:CHE111111111', place: 'Basel', postcode: '4051',
  size_band: '?', verdict: 'resolved', ...over,
});

const LEGAL = 'https://ld.admin.ch/ech/97/legalforms/';
let seq = 0;
const zrow = (name, pc, city, needle, over = {}) => {
  seq += 1;
  return {
    name: { value: name },
    form: { value: `${LEGAL}0106` },
    pc: { value: pc },
    city: { value: city },
    uid: { value: `https://register.ld.admin.ch/zefix/company/${seq}/UID/${over.uid ?? `CHE2000000${String(seq).padStart(2, '0')}`}` },
    d: { value: over.d ?? 'Die Gesellschaft bezweckt den Handel.' },
    needle: { value: needle },
  };
};

function fakeClient({ zefix = () => [], sirene = () => ({ results: [] }) } = {}) {
  const calls = { zefix: [], sirene: [] };
  return {
    calls,
    async zefix(query) {
      calls.zefix.push(query);
      return { results: { bindings: await zefix(query, calls.zefix.length) } };
    },
    async sirene(q) {
      calls.sirene.push(q);
      return sirene(q, calls.sirene.length);
    },
  };
}

function makeCtx(root, client = fakeClient(), { site = null } = {}) {
  const logs = [];
  return {
    logs,
    client,
    ctx: {
      dataRoot: root, table, today: '2026-10-23', client, site, log: (m) => logs.push(m),
      http: { fetchJson: async () => { throw new Error('network is off'); } }, sleep: async () => {},
    },
  };
}
async function run(ctx) {
  const out = [];
  for await (const record of source.fetch(ctx)) out.push(record);
  return out;
}

test('declares a zero-auth campaign source', () => {
  assert.equal(source.id, 'candiboost');
  assert.equal(source.family, 'campaign');
  assert.deepEqual(source.auth, { kind: 'none', vars: [] });
});

test('yields nothing and logs without tables', async () => {
  const root = sandbox();
  const { ctx, logs } = makeCtx(root);
  assert.deepEqual(await run(ctx), []);
  assert.deepEqual(logs, ['candiboost: no Candiboost tables, nothing to resolve']);
  assert.equal(existsSync(resolvedFile(root)), false);
});

test('collects distinct spellings with their domain from both tables', () => {
  const pending = [
    { company: 'Acme  AG', domain: '' },
    { company: 'Beta', domain: 'beta.fr' },
    { company: '   ', domain: 'blank.ch' },
    { company: 'Acme AG', domain: 'acme.ch' },
  ];
  const sends = [
    { company: 'Beta', domain: 'other.ch' },
    { company: 'Gamma\tSA', domain: 'gamma.ch' },
    { company: 'Acme AG', domain: 'late.ch' },
    { company: '', domain: 'x.ch' },
  ];
  assert.deepEqual(collectSpellings(pending, sends), [
    { spelling: 'Acme AG', domain: 'acme.ch' },
    { spelling: 'Beta', domain: 'beta.fr' },
    { spelling: 'Gamma SA', domain: 'gamma.ch' },
  ]);
});

test('queries only spellings without a resolution row', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Firm a' }, { company: 'Firm b' }, { company: 'Firm c' }]);
  writeResolved(root, [resolvedRow({ company: 'Firm a', verdict: 'unresolved' })]);
  const before = readResolved(root).rows[0];
  const { ctx } = makeCtx(root);
  await run(ctx);
  const { zefix, sirene } = ctx.client.calls;
  assert.equal(zefix.length, 1);
  assert.match(zefix[0], /"firm b"/);
  assert.match(zefix[0], /"firm c"/);
  assert.doesNotMatch(zefix[0], /"firm a"/);
  assert.deepEqual([...sirene].sort(), ['firm b', 'firm c']);
  const rows = readResolved(root).rows;
  assert.deepEqual(rows.map((r) => r.company), ['Firm a', 'Firm b', 'Firm c']);
  assert.deepEqual(rows[0], before);
  assert.equal(rows[1].checked, '2026-10-23');
});

test('a failing second batch keeps the first batch rows and rejects', async () => {
  const root = sandbox();
  const names = Array.from({ length: 11 }, (_, i) => `Firm ${String.fromCharCode(97 + i)}`);
  writePending(root, names.map((company) => ({ company })));
  const client = fakeClient({ zefix: (q, n) => { if (n === 2) throw new Error('HTTP 500'); return []; } });
  const { ctx, logs } = makeCtx(root, client);
  await assert.rejects(run(ctx), /HTTP 500/);
  const rows = readResolved(root).rows;
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.company), names.slice(0, 10));
  assert.ok(logs.includes('candiboost: batch 1/2 done'));
  assert.ok(!logs.includes('candiboost: batch 2/2 done'));
});

test('an append skips a spelling written meanwhile', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Firm a' }, { company: 'Firm b' }]);
  const client = fakeClient({
    zefix: () => {
      writeResolved(root, [resolvedRow({ company: 'Firm b', verdict: 'hand', place: 'Zug', postcode: '6300', checked: '2026-10-22' })]);
      return [];
    },
  });
  const { ctx } = makeCtx(root, client);
  await run(ctx);
  const rows = readResolved(root).rows;
  assert.deepEqual(rows.map((r) => r.company).sort(), ['Firm a', 'Firm b']);
  assert.equal(rows.find((r) => r.company === 'Firm b').verdict, 'hand');
});

test('a resolved batch is stored with its register fields and found again without a request', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'ABF Informatik' }]);
  const client = fakeClient({
    zefix: () => [zrow('ABF Informatik AG', '6330', 'Cham', 'abf informatik', { uid: 'CHE123456789', d: 'Die Gesellschaft bezweckt die Softwareentwicklung.' })],
  });
  const first = makeCtx(root, client);
  const records = await run(first.ctx);
  assert.equal(records.length, 1);
  assert.deepEqual(
    readResolved(root).rows[0],
    resolvedRow({
      company: 'ABF Informatik', country: 'CH', legal_name: 'ABF Informatik AG', entity_id: 'uid:CHE123456789', place: 'Cham',
      postcode: '6330', sector: 'zefix-purpose:software', size_band: '?', verdict: 'resolved', checked: '2026-10-23',
    }),
  );
  const second = makeCtx(root);
  await run(second.ctx);
  assert.equal(second.client.calls.zefix.length + second.client.calls.sirene.length, 0);
});

test('yields resolved and hand rows only, logs the count per verdict', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Alpha' }]);
  writeResolved(root, [
    resolvedAt('Alpha'),
    resolvedRow({ company: 'Hand', legal_name: '', verdict: 'hand', place: 'Zug', postcode: '6300', country: 'CH' }),
    resolvedRow({ company: 'Amb', verdict: 'ambiguous' }),
    resolvedRow({ company: 'Out', verdict: 'out-of-zone' }),
    resolvedRow({ company: 'Gone', verdict: 'unresolved' }),
    resolvedRow({ company: 'Gone too', verdict: 'unresolved' }),
  ]);
  const { ctx, logs } = makeCtx(root);
  const records = [];
  for await (const record of source.fetch(ctx)) {
    assert.ok(logs.includes('candiboost: resolved 1 · site 0 · hand 1 · out-of-zone 1 · ambiguous 1 · unresolved 2'), 'verdict log precedes the first record');
    records.push(record);
  }
  assert.deepEqual(records.map((r) => r.name), ['Alpha AG', 'Hand']);
  assert.deepEqual(records[0], {
    name: 'Alpha AG', legalName: 'Alpha AG', aliases: ['Alpha'], entityId: 'uid:CHE111111111', place: 'Basel', postcode: '4051',
    country: 'CH', sector: undefined, sizeBand: '?', sourceId: 'candiboost', signalTokens: [],
  });
  assert.equal(records[1].legalName, undefined);
  assert.equal(records[1].entityId, undefined);
  assert.deepEqual(records[1].aliases, ['Hand']);
});

test('signalTokens only for zefix-purpose:software', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Soft' }]);
  writeResolved(root, [
    resolvedAt('Soft', { sector: 'zefix-purpose:software' }),
    resolvedAt('Naf', { sector: '62.01Z', country: 'FR', size_band: '20-49' }),
  ]);
  const { ctx } = makeCtx(root);
  const [soft, naf] = await run(ctx);
  assert.deepEqual(soft.signalTokens, ['zefix:software']);
  assert.equal(soft.sector, 'zefix-purpose:software');
  assert.deepEqual(naf.signalTokens, []);
  assert.equal(naf.sector, '62.01Z');
  assert.equal(naf.sizeBand, '20-49');
});

const cand = (legalName, place, postcode, entityId) => ({ legalName, sites: [{ place, postcode }], entityId });
const ambiguous = (over = {}) => resolvedRow({
  company: 'Foo', verdict: 'ambiguous', candidates: formatCandidates([cand('Foo Basel AG', 'Basel', '4051', 'uid:CHE300000001'), cand('Foo Zug AG', 'Zug', '6300', 'uid:CHE300000002')]),
  ...over,
});

test('promote: an in-zone listed entity_id resolves the row from its candidate', () => {
  const out = promote(ambiguous({ entity_id: 'uid:CHE300000002' }), table);
  assert.equal(out.log, null);
  assert.equal(out.row.verdict, 'resolved');
  assert.equal(out.row.legal_name, 'Foo Zug AG');
  assert.equal(out.row.place, 'Zug');
  assert.equal(out.row.postcode, '6300');
  assert.equal(out.row.country, 'CH');
  assert.equal(out.row.entity_id, 'uid:CHE300000002');
});

test('promote: an unlisted entity_id is logged and the row is unchanged', () => {
  const row = ambiguous({ entity_id: 'uid:CHE999999999' });
  const out = promote(row, table);
  assert.equal(out.log, 'candiboost: Foo: entity_id not among candidates');
  assert.deepEqual(out.row, row);
});

test('promote: an out-of-zone listed entity_id is logged and the row is unchanged', () => {
  const row = resolvedRow({
    company: 'Foo', verdict: 'out-of-zone', entity_id: 'uid:CHE300000009',
    candidates: formatCandidates([cand('Foo Biel AG', 'Biel/Bienne', '2502', 'uid:CHE300000009')]),
  });
  const out = promote(row, table);
  assert.equal(out.log, 'candiboost: Foo: entity_id uid:CHE300000009 is out of zone');
  assert.deepEqual(out.row, row);
});

test('promote: an in-zone place makes the row hand, an unknown place is logged', () => {
  const hand = promote(resolvedRow({ company: 'Kanton', verdict: 'unresolved', place: 'Zug' }), table);
  assert.equal(hand.log, null);
  assert.equal(hand.row.verdict, 'hand');
  assert.equal(hand.row.place, 'Zug');
  const row = resolvedRow({ company: 'Kanton', verdict: 'unresolved', place: 'Atlantis' });
  const bad = promote(row, table);
  assert.equal(bad.log, 'candiboost: Kanton: place not in the zone table');
  assert.deepEqual(bad.row, row);
});

test('promote: resolved, hand and unedited rows give null', () => {
  assert.equal(promote(resolvedAt('Done'), table), null);
  assert.equal(promote(resolvedRow({ company: 'H', verdict: 'hand', place: 'Zug' }), table), null);
  assert.equal(promote(ambiguous(), table), null);
});

test('a hand edit is promoted in the file once, logged, yielded, and a second run rewrites nothing', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Foo' }, { company: 'Kanton' }, { company: 'Bad' }]);
  writeResolved(root, [
    ambiguous({ entity_id: 'uid:CHE300000002' }),
    resolvedRow({ company: 'Kanton', verdict: 'unresolved', place: 'Zug', postcode: '6300', country: 'CH' }),
    resolvedRow({ company: 'Bad', verdict: 'unresolved', place: 'Atlantis' }),
  ]);
  const first = makeCtx(root);
  const records = await run(first.ctx);
  assert.deepEqual(records.map((r) => r.aliases[0]).sort(), ['Foo', 'Kanton']);
  assert.ok(first.logs.includes('candiboost: Bad: place not in the zone table'));
  const rows = Object.fromEntries(readResolved(root).rows.map((r) => [r.company, r]));
  assert.equal(rows.Foo.verdict, 'resolved');
  assert.equal(rows.Kanton.verdict, 'hand');
  assert.equal(rows.Bad.verdict, 'unresolved');
  assert.equal(rows.Foo.checked, '2026-10-20');

  const digest = sha(resolvedFile(root));
  const second = makeCtx(root);
  const again = await run(second.ctx);
  assert.equal(again.length, 2);
  assert.equal(sha(resolvedFile(root)), digest);
  assert.ok(second.logs.includes('candiboost: Bad: place not in the zone table'));
});

test('a promotion with nothing to change leaves the file byte-identical', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Foo' }]);
  writeResolved(root, [ambiguous({ entity_id: 'uid:CHE999999999' })]);
  const digest = sha(resolvedFile(root));
  const { ctx, logs } = makeCtx(root);
  assert.deepEqual(await run(ctx), []);
  assert.equal(sha(resolvedFile(root)), digest);
  assert.ok(logs.includes('candiboost: Foo: entity_id not among candidates'));
});

test('a malformed resolution file rejects with CandiboostTableError and stays byte-identical', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Foo' }]);
  const line = RESOLVED_COLUMNS.map((c) => (c === 'company' ? 'Foo' : '')).join('\t');
  writeFileSync(resolvedFile(root), `${RESOLVED_COLUMNS.join('\t')}\n${line}\n${line}\n`);
  const digest = sha(resolvedFile(root));
  const { ctx } = makeCtx(root);
  await assert.rejects(run(ctx), CandiboostTableError);
  assert.equal(sha(resolvedFile(root)), digest);
});

test('radar.mjs --source candiboost --write folds a resolved row without network', () => {
  const root = sandbox();
  writePending(root, [{ company: 'ABF Informatik' }]);
  writeResolved(root, [resolvedAt('ABF Informatik', {
    legal_name: 'ABF Informatik AG', entity_id: 'uid:CHE123456789', place: 'Cham', postcode: '6330',
  })]);
  const r = spawnSync(process.execPath, [join(ROOT, 'radar.mjs'), '--source', 'candiboost', '--write'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', CAREER_OPS_SCAN_HISTORY: '' },
  });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr);
  const rows = parseRegistry(readFileSync(join(root, 'data', 'radar.tsv'), 'utf-8')).rows;
  const row = rows.find((x) => x.key === 'abf informatik');
  assert.ok(row, `rows: ${rows.map((x) => x.key)}`);
  assert.ok(row.sources.split(';').includes('candiboost'));
  assert.ok(row.aliases.split(';').includes('ABF Informatik'));
  assert.ok(row.aliases.split(';').includes('#uid:CHE123456789'));
  assert.equal(row.sites, 'Zug:D');
});

const siteRow = (over = {}) => resolvedRow({
  company: 'Kobold', domain: 'koboldgames.ch', country: 'CH', legal_name: 'Kobold Games GmbH', entity_id: 'site:koboldgames.ch',
  place: 'Allschwil', postcode: '4123', size_band: '?', verdict: 'site',
  candidates: formatCandidates([cand('Kobold Games GmbH', 'Allschwil', '4123', 'site:koboldgames.ch')]), ...over,
});
const coopCandidates = formatCandidates([
  cand('Coop Pronto AG', 'Allschwil', '4123', 'uid:CHE108095223'),
  cand('Coop Genossenschaft', 'Basel', '4002', 'uid:CHE105995233'),
]);
const brandRow = (over = {}) => resolvedAt('Coop', { legal_name: 'Coop Pronto AG', entity_id: 'uid:CHE108095223', place: 'Allschwil', postcode: '4123', candidates: coopCandidates, ...over });

test('a site row is yielded under its legal name, counted, and never promoted', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Kobold' }]);
  writeResolved(root, [siteRow()]);
  const { ctx, logs } = makeCtx(root);
  const records = await run(ctx);
  assert.ok(logs.includes('candiboost: resolved 0 · site 1 · hand 0 · out-of-zone 0 · ambiguous 0 · unresolved 0'));
  assert.deepEqual(records, [{
    name: 'Kobold Games GmbH', legalName: 'Kobold Games GmbH', aliases: ['Kobold'], entityId: 'site:koboldgames.ch',
    place: 'Allschwil', postcode: '4123', country: 'CH', sector: undefined, sizeBand: '?', sourceId: 'candiboost', signalTokens: [],
  }]);
  assert.equal(promote(siteRow(), table), null);
});

test('a brand row is named after the spelling and keeps its legal name', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Coop' }, { company: 'gruner ag, gebäudetechnik basel' }]);
  writeResolved(root, [
    brandRow(),
    resolvedAt('gruner ag, gebäudetechnik basel', {
      legal_name: 'Gruner AG', entity_id: 'uid:CHE100000001',
      candidates: formatCandidates([cand('Gruner AG', 'Basel', '4051', 'uid:CHE100000001'), cand('Gruner AG', 'Basel', '4052', 'uid:CHE100000002')]),
    }),
  ]);
  const { ctx } = makeCtx(root);
  const [coop, gruner] = await run(ctx);
  assert.equal(coop.name, 'Coop');
  assert.equal(coop.legalName, 'Coop Pronto AG');
  assert.equal(gruner.name, 'gruner ag');
  assert.equal(gruner.legalName, 'Gruner AG');
});

test('a site hook sees the domain of an unresolved pending row and its patch is stored', async () => {
  const root = sandbox();
  writePending(root, [{ company: 'Kobold', domain: 'koboldgames.ch' }]);
  const seen = [];
  const site = async (spelling, info) => {
    seen.push({ spelling, ...info });
    return { verdict: 'site', country: 'CH', legal_name: 'Kobold Games GmbH', entity_id: 'site:koboldgames.ch', place: 'Allschwil', postcode: '4123', size_band: '?', candidates: '' };
  };
  const { ctx } = makeCtx(root, fakeClient(), { site });
  const records = await run(ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].spelling, 'Kobold');
  assert.equal(seen[0].domain, 'koboldgames.ch');
  assert.equal(readResolved(root).rows[0].verdict, 'site');
  assert.equal(records[0].entityId, 'site:koboldgames.ch');
});

test('radar.mjs --source candiboost --write folds a brand row under the spelling key', () => {
  const root = sandbox();
  writePending(root, [{ company: 'Coop' }]);
  writeResolved(root, [brandRow()]);
  const r = spawnSync(process.execPath, [join(ROOT, 'radar.mjs'), '--source', 'candiboost', '--write'], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', CAREER_OPS_SCAN_HISTORY: '' },
  });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr);
  const rows = parseRegistry(readFileSync(join(root, 'data', 'radar.tsv'), 'utf-8')).rows;
  const row = rows.find((e) => e['key'] === 'coop');
  assert.ok(row, `rows: ${rows.map((e) => e['key'])}`);
  assert.ok(row.aliases.split(';').includes('Coop Pronto AG'));
  assert.ok(row.aliases.split(';').includes('#uid:CHE108095223'));
  assert.equal(row.sites, 'Allschwil:B');
});
