// tests/unslop-diff.test.mjs — diffFacts and `unslop.mjs --diff`: a repair may reword a text but
// must keep every number, date, URL, email and name. Every fixture is fictional.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffFacts } from '../unslop.mjs';

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'unslop.mjs');
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const missing = (before, after) => diffFacts(before, after).missing.map((f) => `${f.cls} ${f.value}`);
const altered = (before, after) => diffFacts(before, after).altered.map((f) => `${f.cls} ${f.from} -> ${f.to}`);

test('a dropped percentage is missing', () => {
  assert.deepEqual(missing('A 75% gain in core performance.', 'A gain in core performance.'), ['percent 75%']);
});

test('a changed number is altered', () => {
  assert.deepEqual(altered('The suite has 1,250 tests.', 'The suite has 1,350 tests.'), ['number 1250 -> 1350']);
});

test('a dropped range and a dropped count are missing', () => {
  assert.deepEqual(missing('The body takes 250-350 words.', 'The body takes words.'), ['range 250-350']);
  assert.deepEqual(missing('Latency fell to 300 ms.', 'Latency fell.'), ['count 300ms']);
});

test('number words and digits are the same fact', () => {
  assert.equal(diffFacts('We moved five services.', 'We moved 5 services.').ok, true);
  assert.equal(diffFacts('We moved 5 services.', 'We moved five services.').ok, true);
  assert.equal(diffFacts('Nous avons migré cinq services.', 'Nous avons migré 5 services.').ok, true);
});

test('a fact only in the second text is not a finding', () => {
  assert.equal(diffFacts('The release shipped.', 'The 9.0.0 release shipped in 2026.').ok, true);
});

test('reordering and rewording around facts pass', () => {
  const before = 'I rewrote 2 components and gained 75% on core performance.';
  const after = 'Core performance rose 75% after the rewrite of 2 components.';
  assert.equal(diffFacts(before, after).ok, true);
});

test('a version number is one fact, not three', () => {
  assert.equal(diffFacts('The 9.0.0 release shipped.', 'The 9.0.0 release shipped.').kept, 1);
  assert.deepEqual(missing('The 9.0.0 release shipped.', 'The release shipped.'), ['number 9.0.0']);
});

test('currency, dates and times: changed or dropped values are reported', () => {
  assert.deepEqual(altered("The band is CHF 120'000 a year.", "The band is CHF 125'000 a year."), ['currency CHF120000 -> CHF125000']);
  assert.deepEqual(missing('I am available from 29 October 2026.', 'I am available soon.'), ['date 29 october 2026']);
  assert.deepEqual(altered('Call me at 14:30 CET.', 'Call me at 15:30 CET.'), ['time 14:30cet -> 15:30cet']);
  assert.equal(diffFacts('Since February 2024 I lead.', 'Since february 2024 I lead.').ok, true);
});

test('a Gradle version is not read as a time', () => {
  assert.equal(diffFacts('We moved to Gradle 8.10 last year.', 'We moved to Gradle 8.10 last year.').ok, true);
  assert.deepEqual(missing('We moved to Gradle 8.10 last year.', 'We moved last year.'), ['number 8.10', 'name Gradle']);
});

test('URLs, bare domains and emails: dropped or changed values are reported', () => {
  assert.deepEqual(missing('See https://example.ch/jobs/42 for details.', 'See the posting for details.'), ['url https://example.ch/jobs/42']);
  assert.deepEqual(missing('Profile: linkedin.com/in/jane-example here.', 'Profile here.'), ['url linkedin.com/in/jane-example']);
  assert.deepEqual(altered('Write to jane@example.com today.', 'Write to jane@example.org today.'), ['email jane@example.com -> jane@example.org']);
});

test('names: a dropped product or company name is missing, a moved one is not', () => {
  assert.deepEqual(missing('We moved the CI of iExec to GitHub Actions.', 'We moved the CI to Actions.'), ['name iExec', 'name GitHub']);
  assert.equal(diffFacts('My first choice is Rust today.', 'Rust is my first choice today.').ok, true);
  assert.equal(diffFacts('Alongside that work, a team grew.', 'In parallel, a team grew.').ok, true);
  assert.equal(diffFacts('Ich lerne weiter Deutsch.', 'Ich lerne weiter Deutsch.').ok, true);
});

test('a name inside a URL or an email is not counted twice', () => {
  const text = 'Mail jane@example.com or see github.com/Natchica for code.';
  const facts = diffFacts(text, text);
  assert.equal(facts.ok, true);
  assert.equal(facts.kept, 2);
});

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: { ...process.env, CAREER_OPS_DATA_DIR: '' },
  encoding: 'utf-8',
});
const file = (name, text) => {
  const dir = mkdtempSync(join(tmpdir(), 'unslop-diff-'));
  sandboxes.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

test('--diff on identical files passes with exit 0', () => {
  const text = 'A 75% gain across 3 services since February 2024.';
  const r = run(['--diff', file('a.txt', text), file('b.txt', text)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Fact check passed: \d+ facts kept\./);
});

test('--diff exits 2 and names the fact a repair dropped', () => {
  const r = run(['--diff', file('a.txt', 'A 75% gain across 3 services.'), file('b.txt', 'A gain across 3 services.')]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Fact check failed: 1 missing, 0 altered/);
  assert.match(r.stdout, /✖ missing percent: 75%/);
});

test('--diff usage errors exit 1', () => {
  const a = file('a.txt', 'One.');
  const cases = [
    [['--diff', a], /--diff takes two files/],
    [['--diff', a, '/nonexistent/b.txt'], /file not found/],
    [['--diff', a, a, '--kind', 'email'], /--diff takes no --kind or --lang/],
  ];
  for (const [args, pattern] of cases) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
  }
});
