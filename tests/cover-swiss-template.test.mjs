// tests/cover-swiss-template.test.mjs — the Swiss cover-letter template pack
// (templates/cover-letter-template.swiss.html), selected by cover_letter.template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTemplate } from '../cv-templates.mjs';
import { buildHtml } from '../generate-cover-letter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACK = join(ROOT, 'templates', 'cover-letter-template.swiss.html');

test('cv-templates resolves cover swiss to the pack', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cover-swiss-'));
  const r = spawnSync(process.execPath, ['cv-templates.mjs', 'resolve', 'cover', 'swiss'], {
    cwd: ROOT, env: { ...process.env, CAREER_OPS_ROOT: tmp }, encoding: 'utf-8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /cover-letter-template\.swiss\.html$/);
});

test('the pack passes validateTemplate for kind cover', () => {
  assert.deepEqual(validateTemplate(PACK, 'cover'), { ok: true, missing: [] });
});

const FULL = {
  candidate: { name: 'NAME-S', email: 'jane@example.com', location: 'Exampleville', phone: '+00 000' },
  letter: {
    role_title: 'ROLE-S',
    company: 'Example AG',
    city: 'Exampleburg',
    date: 'DATE-S',
    recipient: { name: 'RECIPIENT-S', address_lines: ['Example Street 1'] },
    objet: 'OBJET-S',
    greeting: 'GREETING-S,',
    opening: 'OPENING-S',
    profile_intro: 'PROFILE-INTRO-S',
    problems_section: 'PROBLEMS-S',
    closing: 'CLOSING-S',
    language_closing: 'LANGUAGE-CLOSING-S',
    signature: { valediction: 'VALEDICTION-S' },
    annexes: ['ANNEX-S'],
  },
};

test('a full payload renders every Swiss block in order, with no placeholder, list or bold', () => {
  const html = buildHtml(FULL, PACK);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(html, /<ul\b/i);
  assert.doesNotMatch(html, /<(b|strong)\b/i);
  const body = html.slice(html.indexOf('<body>'));
  const order = ['NAME-S', 'jane@example.com', 'RECIPIENT-S', 'DATE-S', 'OBJET-S', 'GREETING-S', 'OPENING-S',
    'PROFILE-INTRO-S', 'PROBLEMS-S', 'CLOSING-S', 'LANGUAGE-CLOSING-S', 'VALEDICTION-S', 'ANNEX-S'];
  let last = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(at > last, `${marker} is missing or out of order (at ${at}, previous ${last})`);
    last = at;
  }
});

test('the pack carries no achievements, credentials or footnotes slot', () => {
  const src = readFileSync(PACK, 'utf-8');
  for (const slot of ['ACHIEVEMENTS_BLOCK', 'CREDENTIALS_BLOCK', 'FOOTNOTES_BLOCK']) {
    assert.ok(!src.includes(`{{${slot}}}`), `${slot} must not be in the Swiss pack`);
  }
});

test('the pack keeps the theming variables and ligature suppression', () => {
  const src = readFileSync(PACK, 'utf-8');
  assert.match(src, /:root\s*\{[^}]*--accent-color:[^}]*--font-family:[^}]*--font-size:[^}]*--page-margin:/s);
  for (const cssVar of ['--accent-color', '--font-family', '--font-size', '--page-margin']) {
    assert.ok(src.includes(`var(${cssVar})`), `var(${cssVar}) is not used`);
  }
  assert.doesNotMatch(src, /--[a-z-]+:\s*var\(/);
  assert.match(src, /font-variant-ligatures:\s*none/);
  assert.match(src, /font-feature-settings:\s*"liga"\s*0\s*,\s*"clig"\s*0\s*,\s*"dlig"\s*0/);
});
