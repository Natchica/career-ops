import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSwissCv } from '../verify-swiss-cv.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(dirname(ROOT), 'verify-swiss-cv.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'verify-swiss-cv-')); dirs.push(d); return d; };

const clean = (over = {}) => ({
  candidate: {
    name: 'Jane Example', title: 'Backend Engineer', email: 'jane@example.com', photo: '/tmp/p.png',
    address: 'Rue Exemple 1, 68000 Colmar', nationality: 'Nationality: French', work_permit: 'Work permit: G or B',
    ...(over.candidate || {}),
  },
  summary: 'Backend engineer in Rust and Java. Lead developer of 3 services. Rewrote 2 components for a 75% gain.',
  languages: [{ language: 'French', level: 'native' }, { language: 'English', level: 'C2' }, { language: 'German', level: 'B1' }],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'candidate')),
});
const codes = (payload, opts) => checkSwissCv(payload, opts).map((f) => f.code);

test('a payload that meets the checklist has no findings', () => {
  assert.deepEqual(checkSwissCv(clean()), []);
});

test('"Curriculum Vitae" in the name or the title is flagged', () => {
  assert.deepEqual(codes(clean({ candidate: { title: 'Curriculum Vitae' } })), ['curriculum-vitae']);
  assert.deepEqual(codes(clean({ candidate: { name: 'CURRICULUM  VITAE Jane' } })), ['curriculum-vitae']);
});

test('a missing or blank address, nationality, work permit and photo are each flagged', () => {
  assert.deepEqual(codes(clean({ candidate: { address: '' } })), ['missing-address']);
  assert.deepEqual(codes(clean({ candidate: { nationality: '   ' } })), ['missing-nationality']);
  assert.deepEqual(codes(clean({ candidate: { work_permit: null } })), ['missing-work-permit']);
  assert.deepEqual(codes(clean({ candidate: { photo: '' } })), ['missing-photo']);
  const bare = { candidate: { name: 'J', title: 'T' }, summary: 'One.', languages: clean().languages };
  assert.deepEqual(codes(bare).sort(), ['missing-address', 'missing-nationality', 'missing-photo', 'missing-work-permit']);
});

test('a summary of more than 5 sentences is flagged, and a decimal does not split a sentence', () => {
  const five = 'One is here. Two is here. Three is here. Four is here. Five has 2.5 years.';
  assert.deepEqual(codes(clean({ summary: five })), []);
  assert.deepEqual(codes(clean({ summary: `${five} Six is here.` })), ['summary-too-long']);
  assert.deepEqual(codes(clean({ summary: 'A **bold** sentence. Another one!  And a third? Yes.' })), []);
});

test('vague adjectives in the summary are flagged by name, in English, French and German', () => {
  const finding = (summary) => checkSwissCv(clean({ summary })).find((f) => f.code === 'vague-adjective');
  assert.match(finding('Determined and organized engineer.').message, /determined/i);
  assert.match(finding('Ingénieur rigoureux et motivé.').message, /rigoureux/i);
  assert.match(finding('Engagiert und motiviert.').message, /motiviert|engagiert/i);
  assert.equal(finding('Lead developer of 3 services, 75% faster.'), undefined);
  assert.equal(finding('The undetermined outcome was fine.'), undefined, 'whole words only');
});

test('Languages must be present, and every entry needs a CEFR level or native', () => {
  assert.deepEqual(codes(clean({ languages: undefined })), ['missing-languages']);
  assert.deepEqual(codes(clean({ languages: [] })), ['missing-languages']);
  assert.deepEqual(codes(clean({ languages: [{ language: 'French' }] })), ['language-level']);
  assert.deepEqual(codes(clean({ languages: [{ language: 'French', level: 'fluent' }] })), ['language-level']);
  for (const level of ['A1', 'b2', 'C2 (certified)', 'native', 'Mother tongue', 'langue maternelle', 'Muttersprache']) {
    assert.deepEqual(codes(clean({ languages: [{ language: 'X', level }] })), [], level);
  }
});

test('a PDF over 5 MB is flagged and exactly 5 MB is not', () => {
  const limit = 5 * 1024 * 1024;
  assert.deepEqual(codes(clean(), { pdfSize: limit }), []);
  assert.deepEqual(codes(clean(), { pdfSize: limit + 1 }), ['pdf-too-large']);
});

test('every finding carries a code and a message', () => {
  for (const f of checkSwissCv({ candidate: {}, languages: [{ language: 'X' }] })) {
    assert.ok(f.code && f.message, JSON.stringify(f));
  }
});

// ---- command line ---------------------------------------------------------------

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  assert.equal(r.error, undefined, r.error?.message);
  return r;
}
const writePayload = (payload) => { const f = join(tmp(), 'payload.json'); writeFileSync(f, typeof payload === 'string' ? payload : JSON.stringify(payload)); return f; };

test('findings print their codes and still exit 0', () => {
  const r = run([writePayload(clean({ candidate: { address: '' }, languages: [] }))]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /missing-address/);
  assert.match(r.stdout, /missing-languages/);
});

test('a clean payload exits 0 and says it passed', () => {
  const r = run([writePayload(clean())]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /passed/);
});

test('usage errors and unreadable input exit 1', () => {
  assert.equal(run([]).status, 1);
  assert.equal(run([join(tmp(), 'missing.json')]).status, 1);
  assert.equal(run([writePayload('{not json')]).status, 1);
  assert.equal(run([writePayload('[]')]).status, 1);
  const noValue = run([writePayload(clean()), '--pdf']);
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /--pdf/);
  assert.equal(run([writePayload(clean()), '--pdf', join(tmp(), 'missing.pdf')]).status, 1);
  const unknown = run([writePayload(clean()), '--pdfx', 'a']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unrecognized flag/);
});

test('--pdf checks the file size', () => {
  const big = join(tmp(), 'big.pdf');
  writeFileSync(big, '');
  truncateSync(big, 5 * 1024 * 1024 + 1);
  const r = run([writePayload(clean()), '--pdf', big]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pdf-too-large/);
  truncateSync(big, 5 * 1024 * 1024);
  assert.doesNotMatch(run([writePayload(clean()), '--pdf', big]).stdout, /pdf-too-large/);
});

test('--help and -h print the same usage and exit 0', () => {
  const a = run(['--help']);
  const b = run(['-h']);
  assert.equal(a.status, 0);
  assert.match(a.stdout, /^Usage:/);
  assert.equal(a.stdout, b.stdout);
});
