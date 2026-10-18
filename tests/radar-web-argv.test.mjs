import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Radar page builds its argv in web/src/lib/radar-run.mjs and reads the
// answer through web/src/lib/radar-stream.mjs. This is the link between those
// and the real radar.mjs: the argv the page would spawn is put to the script.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// web/ is not part of a core-only install, so it is loaded at runtime and these
// tests skip when it is absent.
const WEB_LIB = join(ROOT, 'web', 'src', 'lib');
const hasWeb = existsSync(join(WEB_LIB, 'radar-run.mjs'));
const { createRunTokens, planPreview, planSave } = hasWeb ? await import(pathToFileURL(join(WEB_LIB, 'radar-run.mjs')).href) : {};
const { earnsToken, parseReceipt } = hasWeb ? await import(pathToFileURL(join(WEB_LIB, 'radar-stream.mjs')).href) : {};
const web = (name, fn) => test(name, { skip: hasWeb ? false : 'web/ is not present in this checkout' }, fn);
const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-web-argv-'));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  copyFileSync(join(ROOT, 'tests', 'fixtures', 'radar', 'scan-history.tsv'), join(dir, 'data', 'scan-history.tsv'));
  return dir;
}
const run = (root, argv) =>
  spawnSync(process.execPath, [join(ROOT, 'radar.mjs'), ...argv], {
    cwd: root, encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', CAREER_OPS_SCAN_HISTORY: '' },
  });
const KNOWN = ['ats-employers', 'sirene'];

web('the preview argv the page builds runs and its receipt earns a save token', () => {
  const root = sandbox();
  const plan = planPreview({ source: 'ats-employers' }, KNOWN);
  const r = run(root, plan.argv);
  assert.equal(r.status, 0, r.stderr);
  const receipt = parseReceipt(r.stdout);
  assert.ok(receipt, 'stdout is a receipt');
  assert.equal(receipt.written, false);
  assert.equal(earnsToken(receipt, 'ats-employers'), true);
});

web('the preview argv with zones is accepted and filters', () => {
  const root = sandbox();
  const plan = planPreview({ source: 'ats-employers', zones: ['C'] }, KNOWN);
  const receipt = parseReceipt(run(root, plan.argv).stdout);
  assert.equal(receipt.prospects.new, 1);
});

web('the save argv the page builds is accepted by the script and writes the registry', () => {
  const root = sandbox();
  const tokens = createRunTokens();
  const params = { source: 'ats-employers', zones: [] };
  const token = tokens.issue(params);
  const plan = planSave({ ...params, token }, KNOWN, tokens);
  assert.equal(plan.ok, true);
  const r = run(root, plan.argv);
  assert.equal(r.status, 0, r.stderr);
  const receipt = parseReceipt(r.stdout);
  assert.equal(receipt.written, true);
  assert.equal(receipt.prospects.total, 2);
});

web('every flag in a save argv with zones is one the script accepts', () => {
  const tokens = createRunTokens();
  const params = { source: 'sirene', zones: ['A', 'C'] };
  const plan = planSave({ ...params, token: tokens.issue(params) }, KNOWN, tokens);
  assert.equal(plan.ok, true);
  // --help makes the script check the flags and stop, so nothing is fetched or written.
  const r = run(sandbox(), [...plan.argv, '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Usage:/m);
});
