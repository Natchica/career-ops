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

test('20: fires on chatbot phrases in English and French', () => {
  for (const text of ['I hope this helps.', 'Let me know if you have questions.', 'Certainly! Here is the plan.', 'The plan is ready. Of course, I can adjust it.']) {
    assert.equal(has(text, '20', { lang: 'en' }), true, text);
  }
  for (const text of ['J’espère que cela vous aidera.', 'Bien sûr ! Voici le plan.', 'En tant qu’IA, je ne peux pas.']) {
    assert.equal(has(text, '20', { lang: 'fr' }), true, text);
  }
});

test('20: must not flag a question to the reader, a mid-sentence certainly or a standard French closing', () => {
  assert.equal(has('Could you tell me which stack the team uses?', '20', { lang: 'en' }), false);
  assert.equal(has('The release certainly shipped on time.', '20', { lang: 'en' }), false);
  assert.equal(has('Je reste à votre disposition.', '20', { lang: 'fr' }), false);
  assert.equal(has('N’hésitez pas à me contacter.', '20', { lang: 'fr' }), false);
});

test('22: fires on sycophantic tone, must not flag the word question', () => {
  assert.equal(has('Great question! The stack is Rust.', '22', { lang: 'en' }), true);
  assert.equal(has('Excellente question. La pile est Rust.', '22', { lang: 'fr' }), true);
  assert.equal(has('A question about the stack came up.', '22', { lang: 'en' }), false);
});

test('36: fires on hook lines, must not flag the word catch inside a sentence', () => {
  for (const text of ['The catch? Nobody checks.', 'Here’s the thing. It works.', 'Sound familiar?', 'It ships. Let that sink in.']) {
    assert.equal(has(text, '36', { lang: 'en' }), true, text);
  }
  assert.equal(has('The catch rate rose to 75%.', '36', { lang: 'en' }), false);
});

test('39: fires on meta commentary, must not flag a role description', () => {
  for (const text of ['In this article we cover Rust.', 'Let me walk you through the design.']) {
    assert.equal(has(text, '39', { lang: 'en' }), true, text);
  }
  for (const text of ['Dans cet article, nous voyons Rust.', 'Sans plus attendre, voici le plan.']) {
    assert.equal(has(text, '39', { lang: 'fr' }), true, text);
  }
  assert.equal(has('In this role I aim to own a service.', '39', { lang: 'en' }), false);
});

test('5, 8, 25, 37, 38: fire on their phrases', () => {
  const cases = [
    ['5', 'en', 'Experts believe the stack is sound.'],
    ['5', 'fr', 'Selon les experts, la pile est solide.'],
    ['8', 'en', 'The service serves as a gateway.'],
    ['8', 'en', 'The platform boasts a clean design.'],
    ['25', 'en', 'The future looks bright for the team.'],
    ['25', 'fr', 'L’avenir s’annonce prometteur.'],
    ['37', 'en', 'There are several ways to build this.'],
    ['38', 'en', 'While some might argue otherwise, the design works.'],
  ];
  for (const [id, lang, text] of cases) assert.equal(has(text, id, { lang }), true, `${id}: ${text}`);
});

test('5, 8, 25, 37, 38: must not flag plain uses', () => {
  const cases = [
    ['8', 'The new features shipped last week.'],
    ['8', 'The gateway is a reverse proxy.'],
    ['25', 'The future release adds batching.'],
    ['38', 'It took a first glance at the logs.'],
    ['37', 'There are 3 services in the stack.'],
  ];
  for (const [id, text] of cases) assert.equal(has(text, id, { lang: 'en' }), false, `${id}: ${text}`);
});

test('7 and 26: fire on AI vocabulary and metaphor nouns', () => {
  for (const text of ['We delve into the realm of caching.', 'The work is a testament to the team.']) {
    assert.equal(has(text, '7', { lang: 'en' }), true, text);
  }
  for (const text of ['Reliability is our north star.', 'Tests are the bedrock of the design.']) {
    assert.equal(has(text, '26', { lang: 'en' }), true, text);
  }
});

test('7 and 26: must not flag product names or listed technical collocations', () => {
  assert.equal(has('We store sessions in MongoDB Realm for mobile.', '7', { lang: 'en' }), false);
  assert.equal(has('The model runs on Amazon Bedrock today.', '26', { lang: 'en' }), false);
  for (const text of ['We query a vector database.', 'SIMD vectors speed up the loop.', 'The functional paradigm helps here.', 'It needs project scaffolding first.']) {
    assert.equal(has(text, '26', { lang: 'en' }), false, text);
  }
  // A sentence-initial capital is not provably a name, so it still fires.
  assert.equal(has('Realm of caching is next.', '7', { lang: 'en' }), true);
});

test('9: fires on negative parallelism in English and French', () => {
  for (const text of ['This is not just a tool but a platform.', 'It is not about speed, it is about safety.', 'This isn’t a rewrite. It is a migration.']) {
    assert.equal(has(text, '9', { lang: 'en' }), true, text);
  }
  for (const text of ['Ce service est non seulement rapide mais fiable.', 'Ce n’est pas un outil, c’est une méthode.']) {
    assert.equal(has(text, '9', { lang: 'fr' }), true, text);
  }
});

test('9: must not flag the Optravis gap sentence, a lone not only, or a plain French negation', () => {
  const gap = 'My infrastructure experience covers Docker, CI/CD pipelines and an OCI image for a Java tool, and I have not run production cloud infrastructure at scale. I am therefore open to backend and platform roles generally.';
  assert.equal(has(gap, '9', { lang: 'en' }), false);
  assert.equal(has('The service is not only for internal use.', '9', { lang: 'en' }), false);
  assert.equal(has('Il n’y a pas de régression.', '9', { lang: 'fr' }), false);
});

test('3: fires on -ing tails after a comma', () => {
  for (const text of ['The team shipped it, highlighting its importance.', 'It works, ensuring reliability for users.']) {
    assert.equal(has(text, '3', { lang: 'en' }), true, text);
  }
  assert.equal(has('Il a livré le service, témoignant d’une culture solide.', '3', { lang: 'fr' }), true);
  // A digit in the tail is a fact, not a filler, but only inside the same clause.
  assert.equal(has('It works, ensuring reliability. Release 2.0 shipped.', '3', { lang: 'en' }), true);
});

test('3: must not flag a measured tail or ordinary participles', () => {
  assert.equal(has('It works, ensuring 99.9% uptime.', '3', { lang: 'en' }), false);
  for (const text of ['We are building, logging and streaming events.', 'It ran well, building trust over time.']) {
    assert.equal(has(text, '3', { lang: 'en' }), false, text);
  }
  for (const text of ['Il travaille pendant la nuit, maintenant le service.', 'C’est important, permettant de livrer vite.']) {
    assert.equal(has(text, '3', { lang: 'fr' }), false, text);
  }
});

test('12: fires on a false range, must not flag real ranges or the cv kind', () => {
  assert.equal(has('It covers everything from ancient traditions to modern innovations.', '12', { lang: 'en' }), true);
  for (const text of ['The service runs from design to production.', 'We moved from Java 11 to Java 17.', 'We moved from Jenkins to GitHub Actions.']) {
    assert.equal(has(text, '12', { lang: 'en' }), false, text);
  }
  assert.equal(has('It covers everything from ancient traditions to modern innovations.', '12', { lang: 'en', kind: 'cv' }), false);
});

test('24: fires on stacked hedges, must not flag one may', () => {
  for (const text of ['It could potentially improve latency.', 'It might possibly work.']) {
    assert.equal(has(text, '24', { lang: 'en' }), true, text);
  }
  assert.equal(has('It may improve latency.', '24', { lang: 'en' }), false);
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
