import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const LANGS = [
  { language: 'French', level: 'native' },
  { language: 'English', level: 'C2' },
  { language: 'German', level: 'B1' },
];

const basePayload = (extra = {}) => ({
  lang: 'en',
  page_format: 'a4',
  candidate: { name: 'Jane Example', email: 'jane@example.com', location: 'Colmar, France' },
  summary: 'Backend engineer.',
  experience: [{ company: 'Acme', role: 'Engineer', dates: '2022 - Present', bullets: ['Built a service'] }],
  education: [{ title: 'MSc', org: 'ETH', year: '2021' }],
  skills: [{ category: 'Programming languages', items: 'Rust, Java' }],
  ...extra,
});

/** Run the builder; returns status, stdout, stderr and the written html or markdown (null when none). */
function build(payload, { template = null, markdown = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-languages-'));
  dirs.push(dir);
  const input = join(dir, 'in.json');
  const out = join(dir, markdown ? 'out.md' : 'out.html');
  writeFileSync(input, JSON.stringify(payload));
  const args = [join(ROOT, 'build-cv-html.mjs'), input, ...(markdown ? ['--markdown', out] : [out])];
  if (template) args.push(template);
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: dir } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: existsSync(out) ? readFileSync(out, 'utf-8') : null, dir };
}

const report = (r) => JSON.parse(r.stdout);

// ---- schema -----------------------------------------------------------------

test('languages must be an array, and no output is written when it is not', () => {
  const r = build(basePayload({ languages: 'French' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /languages: expected an array/);
  assert.equal(r.text, null);
});

test('a languages entry needs a language', () => {
  const r = build(basePayload({ languages: [{ level: 'C2' }] }));
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /languages\[0\]/);
  assert.match(r.stderr + r.stdout, /language/);
});

test('an unknown key on a languages entry is a warning, not an error', () => {
  const r = build(basePayload({ languages: [{ language: 'French', lvl: 'C2' }] }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(report(r).warnings.some((w) => /lvl/.test(w)), JSON.stringify(report(r).warnings));
});

test('a languages entry with only a language is valid and warning-free', () => {
  const r = build(basePayload({ languages: [{ language: 'French' }] }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(report(r).warnings, []);
});

// ---- a template without the Languages slot folds the facts into Skills -------

const MODERN = join(ROOT, 'templates', 'cv-template.modern.html');
const skillLines = (html) => [...html.matchAll(/<div class="skill-item">([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

test('on a template with no slot the languages become a last Skills category', () => {
  const r = build(basePayload({ languages: LANGS }), { template: MODERN });
  assert.equal(r.status, 0, r.stderr);
  const lines = skillLines(r.text);
  assert.equal(lines.at(-1), 'Languages: French (native), English (C2), German (B1)');
  assert.equal(lines.length, 2);
});

test('a language with no level is listed bare', () => {
  const r = build(basePayload({ languages: [{ language: 'French' }, { language: 'German', level: 'B1' }] }), { template: MODERN });
  assert.equal(skillLines(r.text).at(-1), 'Languages: French, German (B1)');
});

test('sections.languages renames the folded category', () => {
  const r = build(basePayload({ languages: LANGS, sections: { languages: 'Langues' } }), { template: MODERN });
  assert.match(skillLines(r.text).at(-1), /^Langues: French \(native\)/);
});

test('the report still counts the payload skills, not the folded one', () => {
  const r = build(basePayload({ languages: LANGS }), { template: MODERN });
  assert.equal(report(r).counts.skillCategories, 1);
});

// ---- a template with the Languages slot renders its own section ---------------

const SLOT = '  <!-- LANGUAGES -->\n  {{LANGUAGES_BLOCK}}\n\n';
const SHIPPED = readFileSync(join(ROOT, 'templates', 'cv-template.html'), 'utf-8');

/** The shipped base template with the slot in place (idempotent once the shipped file carries it). */
function slotTemplate(transform = (t) => t) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-languages-tpl-'));
  dirs.push(dir);
  const withSlot = SHIPPED.includes('{{LANGUAGES_BLOCK}}') ? SHIPPED : SHIPPED.replace('  <!-- INTERESTS -->', `${SLOT}  <!-- INTERESTS -->`);
  const file = join(dir, 'cv-template.html');
  writeFileSync(file, transform(withSlot));
  return file;
}

const titles = (html) => [...html.matchAll(/<div class="section-title">([\s\S]*?)<\/div>/g)].map((m) => m[1]);

test('the Languages section sits after Education and before Interests, items in payload order', () => {
  const r = build(basePayload({ languages: LANGS, interests: ['Hiking'], certifications: [{ title: 'Cert', org: 'Org', year: '2023' }] }), { template: slotTemplate() });
  assert.equal(r.status, 0, r.stderr);
  const order = titles(r.text);
  assert.ok(order.indexOf('Languages') > order.indexOf('Education'), order.join(','));
  assert.equal(order.indexOf('Languages') + 1, order.indexOf('Interests'), order.join(','));
  const section = r.text.slice(r.text.indexOf('<div class="section-title">Languages</div>'));
  const items = [...section.slice(0, section.indexOf('<!-- INTERESTS -->')).matchAll(/<div class="skill-item">([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(items, ['French: native', 'English: C2', 'German: B1']);
});

test('with the slot, Skills gets no folded Languages category', () => {
  const r = build(basePayload({ languages: LANGS }), { template: slotTemplate() });
  assert.deepEqual(skillLines(r.text.slice(r.text.indexOf('<!-- SKILLS -->'))), ['Programming languages: Rust, Java']);
});

test('sections.languages renames the section title', () => {
  const r = build(basePayload({ languages: LANGS, sections: { languages: 'Langues' } }), { template: slotTemplate() });
  assert.ok(titles(r.text).includes('Langues'));
  assert.ok(!titles(r.text).includes('Languages'));
});

test('an empty Awards section does not take the Languages section with it, and a populated one stays', () => {
  for (const awards of [[], [{ title: 'Prize', org: 'Org', year: '2020' }]]) {
    const r = build(basePayload({ languages: LANGS, awards }), { template: slotTemplate() });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(titles(r.text).includes('Languages'), `awards ${awards.length}`);
  }
});

test('language text is HTML-escaped and a dollar sequence stays literal', () => {
  const r = build(basePayload({ languages: [{ language: '<b>Fr</b>', level: "$& $1" }] }), { template: slotTemplate() });
  assert.match(r.text, /&lt;b&gt;Fr&lt;\/b&gt;/);
  assert.match(r.text, /\$&amp; \$1/);
});

const withoutSlot = (t) => t.replace(SLOT, '');

test('no languages, or an empty list, leaves no trace: byte-identical to a template that never had the slot', () => {
  const never = build(basePayload({ interests: ['Hiking'] }), { template: slotTemplate(withoutSlot) }).text;
  for (const extra of [{}, { languages: [] }, { languages: [{ level: 'C2' }].slice(1) }]) {
    const r = build(basePayload({ interests: ['Hiking'], ...extra }), { template: slotTemplate() });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.text, never, JSON.stringify(extra));
  }
});

test('a slot spelled on one line still builds, and the token is gone', () => {
  const oneLine = slotTemplate((t) => t.replace(SLOT, '  <!-- LANGUAGES --> {{LANGUAGES_BLOCK}}\n'));
  const r = build(basePayload(), { template: oneLine });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.text, /LANGUAGES_BLOCK/);
  const filled = build(basePayload({ languages: LANGS }), { template: oneLine });
  assert.ok(titles(filled.text).includes('Languages'));
});

// ---- markdown ------------------------------------------------------------------

test('markdown: with the slot, ## Languages sits between Certifications and Interests', () => {
  const r = build(basePayload({ languages: LANGS, interests: ['Hiking'], certifications: [{ title: 'Cert', org: 'Org', year: '2023' }] }), { template: slotTemplate(), markdown: true });
  assert.equal(r.status, 0, r.stderr);
  const headings = [...r.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.equal(headings.indexOf('Languages') - 1, headings.indexOf('Certifications'), headings.join(','));
  assert.equal(headings.indexOf('Languages') + 1, headings.indexOf('Interests'), headings.join(','));
  assert.match(r.text, /- \*\*French:\*\* native\n- \*\*English:\*\* C2\n- \*\*German:\*\* B1/);
});

test('markdown: without the slot the languages fold into the last skills line', () => {
  const r = build(basePayload({ languages: LANGS }), { template: MODERN, markdown: true });
  assert.match(r.text, /- \*\*Languages:\*\* French \(native\), English \(C2\), German \(B1\)\n$/);
  assert.doesNotMatch(r.text, /^## Languages/m);
});

test('markdown: no languages, no section', () => {
  const r = build(basePayload(), { template: slotTemplate(), markdown: true });
  assert.doesNotMatch(r.text, /Languages/);
});

test('without languages a slot-less template renders exactly as before', () => {
  const a = build(basePayload(), { template: MODERN }).text;
  const b = build(basePayload({ languages: [] }), { template: MODERN }).text;
  assert.equal(b, a);
});
