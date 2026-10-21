// tests/cover-objet-annexes.test.mjs — the Objet line and Annexes line slots of
// the cover-letter renderer, used by the Swiss template pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHtml } from '../generate-cover-letter.mjs';
import { verifyFacts } from '../verify-cv-facts.mjs';

function template(slots) {
  const dir = mkdtempSync(join(tmpdir(), 'cover-objet-'));
  const file = join(dir, 'cover-letter-template.html');
  const body = slots.map((s) => `<section data-slot="${s}">{{${s}}}</section>`).join('\n');
  writeFileSync(file, `{{NAME}}{{ROLE_TITLE}}{{OPENING}}{{PROFILE_INTRO}}\n${body}`);
  return file;
}

const payload = (letter = {}) => ({
  candidate: { name: 'Jane Example' },
  letter: { role_title: 'Backend Engineer', opening: 'Opening.', profile_intro: 'Intro.', ...letter },
});

function slotHtml(html, slot) {
  const match = html.match(new RegExp(`<section data-slot="${slot}">([\\s\\S]*?)</section>`));
  assert.ok(match, `rendered letter does not contain data-slot="${slot}"`);
  return match[1];
}

test('objet renders as one escaped div.objet line', () => {
  const html = buildHtml(payload({ objet: 'Application: <x> & y' }), template(['OBJET_LINE']));
  assert.equal(slotHtml(html, 'OBJET_LINE'), '<div class="objet">Application: &lt;x&gt; &amp; y</div>');
});

test('an unset or blank objet renders nothing', () => {
  for (const objet of [undefined, '', '   ']) {
    const html = buildHtml(payload({ objet }), template(['OBJET_LINE']));
    assert.equal(slotHtml(html, 'OBJET_LINE'), '');
  }
});

test('a reference number in the objet does not trip the fact gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-objet-facts-'));
  const cv = join(dir, 'cv.md');
  const cfg = join(dir, 'cv-facts.json');
  writeFileSync(cv, 'Built backend services in Rust.');
  writeFileSync(cfg, JSON.stringify({ allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] }));
  const html = buildHtml(payload({ objet: 'Application: Backend Engineer (ref. 4711)' }), template(['OBJET_LINE']));
  const result = verifyFacts(html, { sourcePaths: [cv], configPath: cfg, label: 'cover letter' });
  assert.notEqual(result.verdict, 'block');
});

test('annexes render the label and the items joined by commas', () => {
  const html = buildHtml(payload({ annexes: ['CV', 'Reference <letter>'] }), template(['ANNEXES_BLOCK']));
  assert.equal(slotHtml(html, 'ANNEXES_BLOCK'), '<p class="annexes">Annexes: CV, Reference &lt;letter&gt;</p>');
});

test('annexes_label overrides the default label', () => {
  const html = buildHtml(payload({ annexes: ['CV'], annexes_label: 'Annexes :' }), template(['ANNEXES_BLOCK']));
  assert.equal(slotHtml(html, 'ANNEXES_BLOCK'), '<p class="annexes">Annexes : CV</p>');
});

test('an empty or unset annexes list renders nothing', () => {
  for (const annexes of [undefined, [], ['  ']]) {
    const html = buildHtml(payload({ annexes }), template(['ANNEXES_BLOCK']));
    assert.equal(slotHtml(html, 'ANNEXES_BLOCK'), '');
  }
});

test('annexes that are not an array of strings throw', () => {
  for (const annexes of ['CV', {}, ['CV', 3]]) {
    assert.throws(() => buildHtml(payload({ annexes }), template(['ANNEXES_BLOCK'])), /letter\.annexes must be an array of strings/);
  }
});

test('a template without the slot renders, drops the line and warns once', (t) => {
  t.mock.method(console, 'error', () => {});
  const html = buildHtml(payload({ annexes: ['CV'] }), template(['OBJET_LINE']));
  assert.ok(!html.includes('{{ANNEXES_BLOCK}}'));
  assert.ok(!html.includes('class="annexes"'));
  assert.equal(console.error.mock.calls.length, 1);
  assert.match(String(console.error.mock.calls[0].arguments[0]), /ANNEXES_BLOCK/);
});

test('no warning when annexes are unset', (t) => {
  t.mock.method(console, 'error', () => {});
  buildHtml(payload(), template(['OBJET_LINE']));
  assert.equal(console.error.mock.calls.length, 0);
});
