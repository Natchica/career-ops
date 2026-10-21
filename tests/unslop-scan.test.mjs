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
