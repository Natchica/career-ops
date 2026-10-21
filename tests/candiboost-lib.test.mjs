import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  PENDING_COLUMNS, REGISTRY_COLUMNS, additionTsv, buildProspectIndex, contactLine, extractCompany, findTrackedRow, parseTable,
  parseThread, planSync, readTable, serializeTable, updateTable,
} from '../lib/candiboost.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'candiboost', 'threads.json'), 'utf-8'));
const T = Object.fromEntries(FIXTURE.map((t) => [t.id, t]));
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a no-dot address takes the greeting last name', () => {
  const p = parseThread(T.cb0002);
  assert.equal(p.record.contact_name, 'Weber');
  assert.equal(p.record.civility, 'M.');
  assert.equal(p.record.domain, 'acme-bank.com');
});

test('the company sentence reads "de X" and the elided "d’X", and drops an article or a bare www', () => {
  const sentence = (tail) => `Je me permets de vous adresser ma candidature spontanée pour un poste de Software Engineer Backend au sein ${tail}.\nJ’ai à cœur de m’investir.`;
  assert.equal(extractCompany(sentence('de BKB')), 'BKB');
  assert.equal(extractCompany(sentence('d’OPTRAVIS')), 'OPTRAVIS');
  assert.equal(extractCompany(sentence("d'AXA")), 'AXA');
  assert.equal(extractCompany(sentence('de l’UNIBAS')), 'UNIBAS');
  assert.equal(extractCompany(sentence('de la POSTE')), 'POSTE');
  assert.equal(extractCompany(sentence('de WWW')), '');
  assert.equal(extractCompany('Bonjour M. Huber,\nVous trouverez mon CV.'), '');
});

test('a hyphenated first name keeps both capitals and a missing company sentence is empty', () => {
  const p = parseThread(T.cb0007);
  assert.equal(p.record.contact_name, 'Jean-Luc Morel');
  assert.equal(p.record.company_raw, '');
});

test('Mme is read from the greeting', () => {
  const p = parseThread(T.cb0003);
  assert.equal(p.record.civility, 'Mme');
  assert.equal(p.record.contact_name, 'Anna Keller');
  assert.equal(p.record.company_raw, 'PISTOR');
});

test('a Failed delivery-status part makes the thread bounced, whatever its labels', () => {
  assert.equal(parseThread(T.cb0002).status, 'bounced');
  const bare = clone(T.cb0002);
  bare.messages[1].labelIds = [];
  assert.equal(parseThread(bare).status, 'bounced');
  const noStatus = clone(T.cb0002);
  noStatus.messages[1].payload.parts.pop();
  assert.equal(parseThread(noStatus).status, 'sent');
});

test('a reply from someone else makes the thread replied and is returned for reply-watch', () => {
  const p = parseThread(T.cb0003);
  assert.equal(p.status, 'replied');
  assert.deepEqual(p.replies, [{
    message_id: 'cb0003r',
    from: 'Anna Keller <anna.keller@pistor.ch>',
    subject: 'RE: Candidature spontanée - Software Engineer Backend - Nathan Gaud',
    body_snippet: p.replies[0].body_snippet,
    signal: null,
    received_at: '2026-10-16T08:12:00.000Z',
  }]);
  assert.match(p.replies[0].body_snippet, /^Bonjour,\nMerci pour votre message/);
  assert.ok(p.replies[0].body_snippet.length <= 2000);
});

test('the owner own later message is ignored', () => {
  const p = parseThread(T.cb0004);
  assert.equal(p.status, 'sent');
  assert.deepEqual(p.replies, []);
});

test('a bounce plus a reply is replied', () => {
  const both = clone(T.cb0002);
  both.messages.push(clone(T.cb0003.messages[1]));
  assert.equal(parseThread(both).status, 'replied');
});

test('a reply body is capped at 2000 characters', () => {
  const long = clone(T.cb0003);
  long.messages[1].payload.body.data = Buffer.from('x'.repeat(5000)).toString('base64url');
  assert.equal(parseThread(long).replies[0].body_snippet.length, 2000);
});

test('threads that fail the shape gate are skipped with a reason and no record', () => {
  assert.deepEqual(parseThread(T.cb0008), { ok: false, thread_id: 'cb0008', reason: 'no-pdf-attachment' });
  assert.deepEqual(parseThread(T.cb0009), { ok: false, thread_id: 'cb0009', reason: 'subject' });
  const unsent = clone(T.cb0001);
  unsent.messages[0].labelIds = ['INBOX'];
  const p = parseThread(unsent);
  assert.deepEqual(p, { ok: false, thread_id: 'cb0001', reason: 'not-sent' });
  assert.equal(p.record, undefined);
  const noTo = clone(T.cb0001);
  noTo.messages[0].payload.headers = noTo.messages[0].payload.headers.filter((h) => h.name !== 'To');
  assert.equal(parseThread(noTo).reason, 'no-recipient');
});

test('parseThread reads a plain send', () => {
  assert.deepEqual(parseThread(T.cb0001), {
    ok: true,
    record: {
      thread_id: 'cb0001', sent_at: '2026-10-14', domain: 'bkb.ch', to_email: 'marco.huber@bkb.ch',
      company_raw: 'BKB', contact_name: 'Marco Huber', civility: 'M.',
    },
    status: 'sent',
    replies: [],
  });
});

const SPEC = { key: 'thread_id', columns: REGISTRY_COLUMNS };
const tmp = () => mkdtempSync(join(tmpdir(), 'candiboost-lib-'));
const reg = (over) => ({ ...Object.fromEntries(REGISTRY_COLUMNS.map((c) => [c, ''])), ...over });

test('the column lists are the documented ones', () => {
  assert.deepEqual(REGISTRY_COLUMNS, ['thread_id', 'sent_at', 'domain', 'company', 'radar_key', 'to_email', 'contact_name', 'civility', 'status', 'tracker', 'followup']);
  assert.deepEqual(PENDING_COLUMNS, ['company', 'radar_key', 'first_seen', 'last_seen']);
});

test('readTable on a missing file is an empty table flagged missing', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readTable(join(dir, 'nope.tsv'), SPEC), { columns: REGISTRY_COLUMNS, rows: [], missing: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serializeTable then parseTable keeps an unknown column and escapes a formula cell', () => {
  const columns = [...REGISTRY_COLUMNS, 'extra'];
  const rows = [reg({ thread_id: 't1', company: '=SUM(A1)', extra: 'kept' })];
  const text = serializeTable({ columns, rows });
  assert.match(text, /\t'=SUM\(A1\)\t/);
  assert.deepEqual(parseTable(text, SPEC), { columns, rows });
});

test('a duplicate key throws', () => {
  const text = serializeTable({ columns: REGISTRY_COLUMNS, rows: [reg({ thread_id: 't1' }), reg({ thread_id: 't1' })] });
  assert.throws(() => parseTable(text, SPEC), /duplicate thread_id "t1"/);
});

test('a short row throws with its line number and is never read as empty', () => {
  const text = `${REGISTRY_COLUMNS.join('\t')}\nt1\t2026-10-14\n`;
  assert.throws(() => parseTable(text, SPEC), /line 2: expected 11 cells, found 2/);
  const dir = tmp();
  try {
    const path = join(dir, 'candiboost.tsv');
    writeFileSync(path, text);
    assert.throws(() => readTable(path, SPEC), /candiboost\.tsv: line 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a header without the key column throws', () => {
  assert.throws(() => parseTable('a\tb\n1\t2\n', SPEC), /no "thread_id" column/);
});

test('updateTable re-reads under the lock and writes atomically', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'data', 'candiboost.tsv');
    const result = await updateTable(path, SPEC, (fresh) => ({ rows: [...fresh.rows, reg({ thread_id: 't1' })], result: fresh.rows.length }));
    assert.equal(result, 0);
    await updateTable(path, SPEC, (fresh) => ({ rows: [...fresh.rows, reg({ thread_id: 't2' })] }));
    assert.deepEqual(readTable(path, SPEC).rows.map((r) => r.thread_id), ['t1', 't2']);
    await assert.rejects(updateTable(path, SPEC, () => { throw new Error('boom'); }), /boom/);
    assert.equal(readTable(path, SPEC).rows.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const prospect = (over) => ({ key: '', name: '', aliases: '', ...over });
const PROSPECTS = [
  prospect({ key: 'adesso schweiz', name: 'adesso Schweiz' }),
  prospect({ key: 'adesso insurance solutions schweiz', name: 'adesso insurance solutions Schweiz', aliases: '#note;AIS' }),
  prospect({ key: 'pistor', name: 'Pistor' }),
];

test('the Radar index matches by exact base name, never by prefix', () => {
  const index = buildProspectIndex(PROSPECTS);
  assert.equal(index.match('ADESSO SCHWEIZ', 'adesso.ch').row.key, 'adesso schweiz');
  assert.equal(index.match('', 'pistor.ch').row.key, 'pistor');
  assert.deepEqual(index.match('BKB', 'bkb.ch'), { row: null, ambiguous: false });
  assert.equal(index.match('AIS', 'adesso.ch').row.key, 'adesso insurance solutions schweiz');
  assert.equal(index.match('note', 'x.ch').row, null);
});

test('two Prospects with one base are ambiguous', () => {
  const index = buildProspectIndex([prospect({ key: 'foo|fr|a', name: 'Foo SA' }), prospect({ key: 'foo|ch|b', name: 'Foo AG' })]);
  assert.deepEqual(index.match('FOO', 'foo.ch'), { row: null, ambiguous: true });
});

test('findTrackedRow matches by company and takes the newest row', () => {
  const rows = [{ num: 1, company: 'Roche' }, { num: 7, company: 'Roche AG' }, { num: 3, company: 'Other' }];
  assert.equal(findTrackedRow(['ROCHE'], rows).num, 7);
  assert.equal(findTrackedRow(['BKB'], rows), null);
  assert.equal(findTrackedRow(['', 'x', 'other'], rows).num, 3);
});

const TRACKER = [{ num: 1, company: 'Roche', status: 'Applied' }];
const ctx = () => ({ prospectIndex: buildProspectIndex(PROSPECTS), trackerRows: TRACKER });
const parsedAll = () => FIXTURE.map((t) => parseThread(t));

test('planSync over an empty registry plans seven records, five new companies and one tracked', () => {
  const plan = planSync([], parsedAll(), ctx());
  assert.equal(plan.newRecords.length, 7);
  assert.deepEqual(plan.skipped.map((s) => s.thread_id), ['cb0008', 'cb0009']);
  assert.equal(plan.sends, 7);
  assert.deepEqual(plan.trackerPlan.newCompanies.map((c) => c.company), ['BKB', 'ACME BANK', 'Pistor', 'adesso Schweiz', 'optimo-example.ch']);
  assert.deepEqual(plan.trackerPlan.newCompanies[0].threadIds, ['cb0001', 'cb0006']);
  assert.deepEqual(plan.trackerPlan.alreadyTracked, [{ company: 'Roche', row: 1, date: '2026-10-16', threadIds: ['cb0005'] }]);
  assert.deepEqual(plan.radar, { matched: 2, unmatched: 5, ambiguous: 0 });
  assert.equal(plan.newRecords.find((r) => r.thread_id === 'cb0004').radar_key, 'adesso schweiz');
  assert.equal(plan.newRecords.find((r) => r.thread_id === 'cb0007').company, 'optimo-example.ch');
  assert.equal(plan.newRecords.find((r) => r.thread_id === 'cb0002').status, 'bounced');
  assert.equal(plan.newRecords.find((r) => r.thread_id === 'cb0003').status, 'replied');
  assert.deepEqual(plan.replies.map((r) => r.reply.message_id), ['cb0003r']);
});

test('the within-batch company fold ignores case', () => {
  const a = parseThread(T.cb0001);
  const b = clone(parseThread(T.cb0006));
  b.record.company_raw = 'Bkb';
  const plan = planSync([], [a, b], ctx());
  assert.equal(plan.trackerPlan.newCompanies.length, 1);
});

const settle = (plan) => plan.newRecords.map((r) => ({ ...r, tracker: '2' }));

test('re-planning with the registry the first run produced changes nothing', () => {
  const first = planSync([], parsedAll(), ctx());
  const again = planSync(settle(first), parsedAll(), ctx());
  assert.equal(again.newRecords.length, 0);
  assert.equal(again.statusChanges.length, 0);
  assert.equal(again.trackerPlan.newCompanies.length, 0);
});

test('a thread that gains a bounce changes its status only', () => {
  const first = planSync([], parsedAll(), ctx());
  const registry = settle(first).map((r) => (r.thread_id === 'cb0002' ? { ...r, status: 'sent' } : r));
  const again = planSync(registry, parsedAll(), ctx());
  assert.deepEqual(again.statusChanges, [{ thread_id: 'cb0002', from: 'sent', to: 'bounced' }]);
  assert.equal(again.newRecords.length, 0);
});

test('a status is never downgraded', () => {
  const first = planSync([], parsedAll(), ctx());
  const registry = settle(first).map((r) => (r.thread_id === 'cb0002' ? { ...r, status: 'replied' } : r));
  assert.equal(planSync(registry, parsedAll(), ctx()).statusChanges.length, 0);
});

test('additionTsv writes the header and one Applied row', () => {
  assert.equal(
    additionTsv({ num: 2, date: '2026-10-14', company: 'BKB' }),
    'num\tdate\tcompany\tvia\trole\tscore\tstatus\tpdf\treport\tnotes\n2\t2026-10-14\tBKB\t—\tSpontaneous application\tN/A\tApplied\t❌\t—\tcandiboost; contact type hiring contact\n',
  );
});

test('contactLine has nine cells, escapes a formula and flattens a tab', () => {
  const line = contactLine({ name: '=Evil\tName', company: 'BKB', email: 'a@bkb.ch', tracker: 2, date: '2026-10-14' });
  const cells = line.split('\t');
  assert.equal(cells.length, 9);
  assert.equal(cells[0], "'=Evil Name");
  assert.deepEqual([cells[1], cells[2], cells[5], cells[7], cells[8]], ['BKB', 'other', 'a@bkb.ch', '2', 'from candiboost send 2026-10-14']);
  assert.equal(contactLine({ name: 'X', company: 'Y', email: 'z@y.ch', tracker: null, date: '2026-10-14' }).split('\t')[7], '-');
});
