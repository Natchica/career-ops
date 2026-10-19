import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const basePayload = (candidate = {}) => ({
  lang: 'en',
  page_format: 'a4',
  candidate: { name: 'Jane Example', email: 'jane@example.com', phone: '+41 00 000 00 00', location: 'Colmar, France', ...candidate },
  summary: 'Backend engineer.',
  experience: [{ company: 'Acme', role: 'Engineer', dates: '2022 - Present', bullets: ['Built a service'] }],
  education: [{ title: 'MSc', org: 'ETH', year: '2021' }],
  skills: [{ category: 'Languages', items: 'Rust' }],
});

function build(payload, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-swiss-header-'));
  dirs.push(dir);
  const input = join(dir, 'in.json');
  writeFileSync(input, JSON.stringify(payload));
  const args = extra.includes('--markdown')
    ? [join(ROOT, 'build-cv-html.mjs'), input, '--markdown', join(dir, 'out.md')]
    : [join(ROOT, 'build-cv-html.mjs'), input, join(dir, 'out.html')];
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: dir } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return readFileSync(join(dir, extra.includes('--markdown') ? 'out.md' : 'out.html'), 'utf-8');
}

const contactRows = (html) => [...html.matchAll(/<div class="contact-row[^"]*"[^>]*>[\s\S]*?<\/div>/g)].map((m) => m[0]);
const items = (row) => [...row.matchAll(/<(a|span)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);

test('a street address replaces the bare location in the contact row, with the same number of items', () => {
  const plain = contactRows(build(basePayload()))[0];
  const withAddress = contactRows(build(basePayload({ address: 'Rue Exemple 1, 68000 Colmar' })))[0];
  assert.match(withAddress, /Rue Exemple 1, 68000 Colmar/);
  assert.doesNotMatch(withAddress, /<span>Colmar, France<\/span>/);
  assert.equal(items(withAddress).length, items(plain).length);
});

test('a blank address leaves the location in place', () => {
  const row = contactRows(build(basePayload({ address: '   ' })))[0];
  assert.match(row, /Colmar, France/);
});

const personal = (html) => contactRows(html).find((r) => r.includes('contact-row--personal'));

test('nationality, work permit and date of birth form a second row directly under the contact row, in that order', () => {
  const html = build(basePayload({ nationality: 'Nationality: French', work_permit: 'Work permit: G or B', date_of_birth: 'Date of birth: 01.02.1990' }));
  const rows = contactRows(html);
  assert.equal(rows.length, 2);
  assert.ok(html.indexOf(rows[0]) < html.indexOf(rows[1]));
  assert.equal(html.slice(html.indexOf(rows[0]) + rows[0].length).trimStart().startsWith('<div class="contact-row contact-row--personal"'), true);
  assert.deepEqual(items(rows[1]), ['Nationality: French', 'Work permit: G or B', 'Date of birth: 01.02.1990']);
});

test('each field alone gives exactly one item', () => {
  for (const key of ['nationality', 'work_permit', 'date_of_birth']) {
    const row = personal(build(basePayload({ [key]: 'x value' })));
    assert.deepEqual(items(row), ['x value'], key);
  }
});

test('blank, whitespace, null and object values count as absent', () => {
  for (const value of ['', '   ', null, {}]) {
    assert.equal(personal(build(basePayload({ nationality: value, work_permit: value, date_of_birth: value }))), undefined, JSON.stringify(value));
  }
});

test('with no field the HTML is byte-identical to a payload that never had the keys', () => {
  const without = build(basePayload());
  const blank = build(basePayload({ nationality: '', work_permit: '  ', date_of_birth: null }));
  assert.equal(blank, without);
});

test('markdown shows the address in place of the location and a personal line after the contact line', () => {
  const md = build(basePayload({ address: 'Rue Exemple 1, 68000 Colmar', nationality: 'Nationality: French', date_of_birth: 'Date of birth: 01.02.1990' }), ['--markdown']);
  const lines = md.split('\n');
  const contact = lines.findIndex((l) => l.includes('jane@example.com'));
  assert.match(lines[contact], /Rue Exemple 1, 68000 Colmar/);
  assert.doesNotMatch(lines[contact], /Colmar, France/);
  assert.equal(lines[contact + 2], 'Nationality: French | Date of birth: 01.02.1990');
});

test('markdown has no personal line when every field is blank', () => {
  const md = build(basePayload({ nationality: '', work_permit: null }), ['--markdown']);
  assert.doesNotMatch(md, /Nationality|Work permit|Date of birth/);
  assert.equal(md, build(basePayload(), ['--markdown']));
});

test('header text is HTML-escaped', () => {
  const row = personal(build(basePayload({ nationality: '<b>x</b>' })));
  assert.match(row, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(row, /<b>x<\/b>/);
});
