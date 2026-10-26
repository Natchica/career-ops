import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const mode = read('modes/spontaneous.md');

test('the mode is draft-only and says so first', () => {
  assert.match(mode.split('\n').slice(0, 4).join('\n'), /Never send, submit or click\. Draft only\./);
});

test('the mode names every script and mode it depends on', () => {
  for (const needle of [
    'spontaneous-pick.mjs next',
    'spontaneous-pick.mjs mark',
    'radar-tiers.mjs --explain',
    'contact-lookup.mjs',
    'modes/contacto.md',
    'modes/pdf.md',
    'modes/email.md',
    'cold_application',
    'merge-tracker.mjs',
    'reserve-report-num.mjs',
    'verify-cv-facts.mjs',
    'verify-letter.mjs',
    '## Checks',
    '`voice-dna.md` §1',
    'No JD — Spontaneous application to a Radar Prospect',
  ]) assert.ok(mode.includes(needle), `modes/spontaneous.md does not mention ${needle}`);
});

test('the tracker row is a no-score, no-report Applied row with Via dash, written after the send', () => {
  assert.match(mode, /`N\/A`/);
  assert.match(mode, /`Applied`/);
  assert.match(mode, /`Spontaneous application`/);
  assert.match(mode, /only after the candidate confirms the send/);
});

test('the CV step skips the JD steps and does not pass --report', () => {
  assert.match(mode, /Skip pdf steps 2, 3, 4, 8, 9/);
  assert.match(mode, /without `--report`/);
  assert.doesNotMatch(mode, /--report=\{/);
});

test('Swiss employers go through the Swiss CV house rule, the checker and the sent copy', () => {
  assert.ok(mode.includes('verify-swiss-cv.mjs'), 'names the checker');
  assert.ok(mode.includes('output/send/'), 'names the sent copy folder');
  assert.ok(mode.includes('modes/_custom.md'), 'points to the house rule');
});

test('contact details never reach the brief, the tracker or output/', () => {
  assert.match(mode, /never into the brief, the tracker or `output\/`/);
  assert.match(mode, /the contact's type, never their name/);
});

test('contacto carries the Spontaneous persona and maps it onto existing saved types', () => {
  const contacto = read('modes/contacto.md');
  assert.ok((contacto.match(/Hiring contact \(Spontaneous\)/g) ?? []).length >= 2);
  assert.match(contacto, /as\s+`recruiter`/);
  const types = readFileSync(join(ROOT, 'contacts.mjs'), 'utf-8').match(/const VALID_TYPES = new Set\(\[(.*?)\]\)/)?.[1] ?? '';
  assert.equal(types.split(',').length, 6, 'contacts.mjs VALID_TYPES changed: revisit the persona mapping');
});

test('the router and AGENTS.md route spontaneous', () => {
  const skill = read('.agents/skills/career-ops/SKILL.md');
  assert.match(skill, /^\| `spontaneous` \| `spontaneous` \|$/m);
  assert.match(read('AGENTS.md'), /`spontaneous` — picks the best untouched tier 1 Prospect/);
});

test('step 3 opens the Site probe domain first and says what a missing site means', () => {
  const step3 = mode.split('\n').find((l) => l.startsWith('3. **Research the company live.**')) ?? '';
  assert.match(step3, /`web:`/);
  assert.match(step3, /https:\/\/\{domain\}\//);
  assert.match(step3, /counts as one of the 4/);
  assert.match(step3, /`no site found`/);
  assert.match(mode, /radar-enrich\.mjs --sites/);
});
