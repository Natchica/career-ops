import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const mode = read('modes/candiboost.md');

test('the mode is draft-only and says so first', () => {
  assert.match(mode.split('\n').slice(0, 4).join('\n'), /Never send, submit or click\. Draft only\./);
});

test('the mode treats Gmail, bounces, replies and the Candiboost page as untrusted data', () => {
  assert.ok(mode.includes('Untrusted External Content'));
});

test('the mode names every script, flag and mode it depends on', () => {
  for (const needle of [
    'candiboost-sync.mjs sync --dry-run --summary',
    'candiboost-sync.mjs pick',
    'candiboost-sync.mjs mark',
    'candiboost-pending.mjs ingest',
    'candiboost-pending.mjs rank',
    'node --env-file=.env',
    'modes/spontaneous.md',
    'modes/pdf.md',
    'modes/email.md',
    'verify-letter.mjs',
    '--kind email',
    '--company',
    '`voice-dna.md` §1',
    'verify-swiss-cv.mjs',
    'set-status.mjs',
    'data/follow-ups.md',
    'spontaneous-pick.mjs mark',
    'Re: ',
    '## Checks',
  ]) assert.ok(mode.includes(needle), `modes/candiboost.md does not mention ${needle}`);
});

test('the mode never clicks on the Candiboost page and leaves deletion to the candidate', () => {
  assert.match(mode, /never clicks/);
  assert.match(mode, /delete/);
});

test('the pending flow reads every page of the "En attente" filter into /tmp/candiboost-pending.json', () => {
  assert.ok(mode.includes('"En attente"'), 'names the status filter');
  assert.ok(mode.includes('/tmp/candiboost-pending.json'), 'names the hand-off file');
  assert.match(mode, /every page/);
  assert.ok(mode.includes('`[{company, status}]`'), 'names the JSON shape');
  assert.ok(mode.includes('browser_navigate'), 'navigates with Playwright');
  assert.match(mode, /candidate gives the page URL/);
});

test('the follow-up and the template both end with the Outbound text gate for kind email', () => {
  const gate = /Run the Outbound text gate \(`modes\/_writing\.md`\), kind `email`/g;
  assert.ok((mode.match(gate) ?? []).length >= 2, 'follow and template must each run the gate');
  assert.match(mode, /^\s*(?:[-*]\s+)?Read `modes\/_writing\.md`/m);
});
