import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThread } from '../lib/candiboost.mjs';

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
