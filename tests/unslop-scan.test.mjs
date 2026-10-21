// tests/unslop-scan.test.mjs — scanText and the unslop.mjs CLI. Every fixture is fictional.
// Each implemented rule gets one text that fires it and one must_not_flag text that stays quiet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../unslop.mjs';

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'unslop.mjs');
const NULL_IDS = ['10', '11', '14', '16', '17', '27', '28', '32', '33c'];

const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const sandbox = () => { const d = mkdtempSync(join(tmpdir(), 'unslop-scan-')); sandboxes.push(d); return d; };

/** Finding ids of a scan: the assertion is about which rules fired, not their wording. */
const ids = (text, opts) => scanText(text, opts).findings.map((f) => f.id);

test('an empty text gives exactly empty-text, warn', () => {
  for (const text of ['', '  \n']) {
    const { findings } = scanText(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'empty-text');
    assert.equal(findings[0].severity, 'warn');
  }
});

test('judgement rules are skipped with their reason, never findings', () => {
  const { findings, skipped } = scanText('Plain text.');
  assert.deepEqual(findings, []);
  assert.deepEqual(skipped.map((s) => s.id), NULL_IDS);
  for (const s of skipped) assert.ok(s.reason, `skipped rule ${s.id} needs a reason`);
});

test('an unknown kind throws', () => {
  assert.throws(() => scanText('Plain text.', { kind: 'memo' }), /kind must be one of/);
});

test('a detector that throws becomes a block detector-error finding', () => {
  const broken = [{ id: '99', name: 'Broken', severity: 'block', detect: 'match-list', scope: 'prose', kinds: 'all', lang: 'all', patterns: { all: ['('] }, source: null }];
  const { findings } = scanText('Plain text.', { rules: broken });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'block');
  assert.equal(findings[0].term, 'detector-error');
});

test('13: fires on an em dash, a spaced en dash and a spaced double hyphen', () => {
  assert.deepEqual(ids('Rust — fast and safe.'), ['13']);
  assert.deepEqual(ids('A gain – measured in production.'), ['13']);
  assert.deepEqual(ids('A gain -- measured in production.'), ['13']);
});

test('13: must not flag an unspaced range dash or a hyphenated compound', () => {
  for (const text of ['The body takes 250–350 words.', 'From 2024–2026 at iExec.', 'Basel–Zurich is a short train ride.', 'An end-to-end service for EU-CH payments.']) {
    assert.deepEqual(ids(text), [], text);
  }
});

const has = (text, id, opts) => ids(text, opts).includes(id);

test('18: fires on emoji and flag pairs', () => {
  for (const text of ['Shipped it \u{1F680}', 'All green ✅', 'Nice \u{1F44D}', 'Based in Basel \u{1F1E8}\u{1F1ED}']) {
    assert.equal(has(text, '18'), true, text);
  }
});

test('18: must not flag symbols that are not emoji', () => {
  for (const text of ['© Example AG', 'Example® platform', 'Example™ platform', 'Rust → Java', 'C++ and C# services']) {
    assert.equal(has(text, '18'), false, text);
  }
});

test('19: fires on curly quotes and apostrophes in English', () => {
  for (const text of ['The “quoted” part.', 'The ‘x’ flag.', 'iExec’s platform.']) {
    assert.equal(has(text, '19', { lang: 'en' }), true, text);
  }
});

test('19: must not flag straight quotes, French elision or guillemets', () => {
  assert.equal(has('The "quoted" part and iExec\'s platform.', '19', { lang: 'en' }), false);
  assert.equal(has('Je rejoins l’équipe de développement.', '19', { lang: 'fr' }), false);
  assert.equal(has('Le test « vert » passe.', '19', { lang: 'fr' }), false);
  assert.equal(has('Il dit “bonjour”.', '19', { lang: 'fr' }), true);
});

test('40: fires on zero-width characters, soft hyphens and Latin words with a Cyrillic letter', () => {
  for (const text of ['A Ru​st service.', 'The soft­ware team.', 'A Rаst service.']) {
    assert.equal(has(text, '40'), true, JSON.stringify(text));
  }
});

test('40: must not flag percent spacing, thousands separators, Greek units or accents', () => {
  for (const text of ['A gain of 75 %.', 'More than 1 250 tests.', 'Latency in μs.', 'Offices in Zürich.', 'By Nathan Gaud.']) {
    assert.equal(has(text, '40'), false, JSON.stringify(text));
  }
});

test('35: fires on bracket, brace and filler placeholders', () => {
  for (const text of ['Dear [Your Name],', 'At [INSERT company] I built it.', 'Dear {company},', 'Hello {{NAME}}.', "A salary of CHF XX'000.", 'Start date: TBD.']) {
    assert.equal(has(text, '35'), true, text);
  }
});

test('35: must not flag the confirm marker, parentheses or roman numerals', () => {
  for (const text of ['Dear [confirm name],', 'Start on [Confirm start date].', 'Eligible (permit G) from October.', 'A size XXL shirt.', 'Le XXe siècle.']) {
    assert.equal(has(text, '35'), false, text);
  }
});

test('34: fires on markdown in an email body', () => {
  for (const text of ['# Heading\nBody.', '- item one\n- item two', '1. first\n2. second', 'See [the site](https://example.ch) now.', 'Run `make` first.', '> quoted line']) {
    assert.equal(has(text, '34', { kind: 'email' }), true, text);
  }
});

test('34: must not flag bullets in answers and CVs, phone lines or version numbers', () => {
  assert.equal(has('- item one\n- item two', '34', { kind: 'answer' }), false);
  assert.equal(has('- item one\n- item two', '34', { kind: 'cv' }), false);
  for (const text of ['Phone\n+33 7 69 24 81 14', 'We use C# and F# here.', 'The 9.0.0 release shipped.']) {
    assert.equal(has(text, '34', { kind: 'email' }), false, text);
  }
});

test('15: fires on bold in an email', () => {
  assert.equal(has('This is **important** work.', '15', { kind: 'email' }), true);
  assert.equal(has('This is __important__ work.', '15', { kind: 'email' }), true);
});

test('15: must not flag bold in answers and CVs, or a multiplication', () => {
  assert.equal(has('This is **important** work.', '15', { kind: 'answer' }), false);
  assert.equal(has('This is **important** work.', '15', { kind: 'cv' }), false);
  assert.equal(has('The result is 2*3 in the test.', '15', { kind: 'email' }), false);
});

test('33: fires on arrows and w/ in an email', () => {
  for (const text of ['Jenkins → GitHub Actions on all services.', 'I rewrote it w/ Rust last year.', 'The path a -> b is short.', 'The path a => b is short.']) {
    assert.equal(has(text, '33', { kind: 'email' }), true, text);
  }
});

test('33b: fires on an ampersand between lowercase words', () => {
  assert.equal(has('We build & ship services.', '33b', { kind: 'email' }), true);
});

test('33 and 33b: must not flag arrows in CVs and messages, company names or URLs', () => {
  assert.equal(has('Jenkins → GitHub Actions', '33', { kind: 'cv' }), false);
  assert.equal(has('Jenkins → GitHub Actions', '33', { kind: 'message' }), false);
  for (const text of ['The R&D team.', 'The AT&T network.', 'Procter & Gamble hired me.', 'See github.com/w/x for details.']) {
    assert.equal(has(text, '33', { kind: 'email' }) || has(text, '33b', { kind: 'email' }), false, text);
  }
});

test('scanText is exported with ids()', () => {
  assert.deepEqual(ids('Plain text.'), []);
});

const run = (args, root = sandbox()) => spawnSync(process.execPath, [SCRIPT, ...args], {
  env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '' },
  encoding: 'utf-8',
});
const file = (name, text) => { const path = join(sandbox(), name); writeFileSync(path, text); return path; };

test('--help and -h print the same usage and exit 0', () => {
  const long = run(['--help']);
  const short = run(['-h']);
  assert.equal(long.status, 0);
  assert.match(long.stdout, /^Usage:/);
  assert.equal(short.stdout, long.stdout);
});

test('usage errors and unreadable input exit 1', () => {
  const body = file('body.txt', 'Plain text.');
  const cases = [
    [[], /give the text file/],
    [['/nonexistent/body.txt'], /file not found/],
    [[body, '--kind', 'memo'], /--kind must be one of/],
    [[body, '--lang', 'de'], /--lang must be en or fr/],
    [['--kindx', body], /unrecognized flag/],
    [[body, '--kind'], /--kind/],
  ];
  for (const [args, pattern] of cases) {
    const r = run(args);
    assert.equal(r.status, 1, `${args.join(' ')} should exit 1`);
    assert.match(r.stderr, pattern, args.join(' '));
  }
});

test('a clean text prints the passed line and exits 0', () => {
  const r = run([file('clean.txt', 'Plain text.')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Slop check passed \(kind text, lang en\): no findings\./);
  assert.match(r.stdout, /Not scanned \(reading check\): 10, 11, 14, 16, 17, 27, 28, 32, 33c/);
});
