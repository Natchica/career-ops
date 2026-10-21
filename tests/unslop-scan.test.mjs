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

test('7b: fires on two tier 2 words in one paragraph', () => {
  const { findings } = scanText('A robust and seamless pipeline ships weekly.', { lang: 'en' });
  const hit = findings.find((f) => f.id === '7b');
  assert.ok(hit, '7b should fire');
  assert.deepEqual(hit.hits.map((h) => h.toLowerCase()), ['robust', 'seamless']);
});

test('7b: must not flag one word per paragraph or a capitalised name', () => {
  assert.equal(has('A robust pipeline ships.\n\nA seamless rollout followed.', '7b', { lang: 'en' }), false);
  assert.equal(has('We work with Robust Inc. and a seamless setup.', '7b', { lang: 'en' }), false);
  assert.equal(has('A robust pipeline ships weekly.', '7b', { lang: 'en' }), false);
});

test('23 and 31: fire with a repair hint', () => {
  const hint = (text, id, lang = 'en') => scanText(text, { lang }).findings.find((f) => f.id === id)?.hint;
  assert.equal(hint('We did it in order to ship.', '23'), 'use "to"');
  assert.equal(hint('It’s important to note that it works.', '23'), 'delete it');
  assert.equal(hint('Il est important de noter que cela marche.', '23', 'fr'), 'delete it');
  assert.equal(hint('Cela marche du fait que le test passe.', '23', 'fr'), 'use "parce que"');
  assert.equal(hint('We utilize the cache.', '31'), 'use "use"');
  assert.equal(hint('We leverage the cache.', '31'), 'use "use"');
  assert.equal(hint('Numerous users joined.', '31'), 'use "many"');
  assert.equal(hint('Retry in the event that it fails.', '31'), 'use "if"');
});

test('23 and 31: must not flag French connectors, a leverage ratio or a company name', () => {
  for (const text of ['Je livre afin de réduire le risque.', 'Cela marche parce que le test passe.', 'Dans le cadre de ce projet, je livre.', 'Au sein de cette équipe, je livre.']) {
    assert.equal(has(text, '23', { lang: 'fr' }), false, text);
  }
  assert.equal(has('The leverage ratio is high.', '31', { lang: 'en' }), false);
  assert.equal(has('We joined Leverage Labs last year.', '31', { lang: 'en' }), false);
});

test('29: fires on an agentless passive', () => {
  for (const text of ['The queries are validated before release.', 'The release was shipped last week.', 'The tests were run nightly.']) {
    assert.equal(has(text, '29', { lang: 'en' }), true, text);
  }
});

test('29: must not flag adjectival participles, a by-actor, or the cv kind', () => {
  for (const text of ['My CV is attached.', 'I am based in Sentheim.', 'I am interested in the role.', 'I am open to backend roles.', 'Each step was reviewed by a second engineer.', 'I am a French citizen.']) {
    assert.equal(has(text, '29', { lang: 'en' }), false, text);
  }
  assert.equal(has('The queries are validated before release.', '29', { lang: 'en', kind: 'cv' }), false);
});

test('30: fires on a high density of adverbs', () => {
  const text = 'We quickly shipped the service and it significantly improved latency for users who really need it, so the team moved on to the next task and kept the release cycle short and the tests green for every change.';
  const hit = scanText(text, { lang: 'en' }).findings.find((f) => f.id === '30');
  assert.ok(hit, '30 should fire');
  assert.deepEqual(hit.hits.map((h) => h.toLowerCase()), ['quickly', 'significantly', 'really']);
});

test('30: must not flag words that only look like adverbs or a low density', () => {
  assert.equal(has('We only ship early on a daily basis, the family team likes July, and a likely release lands soon after the review of the main change and the release notes.', '30', { lang: 'en' }), false);
  const long = `We quickly ship. ${'Release notes cover the service and the tests. '.repeat(30)}It significantly improves.`;
  assert.equal(has(long, '30', { lang: 'en' }), false);
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

// Same fixtures as tests/verify-letter.test.mjs (clean letters that voice-dna.md section 1 prescribes).
const P1 = 'Example AG builds compliance software for Swiss banks, and your posting for a Backend Engineer describes a team that runs its own services from design to production. Since February 2024 I have been lead developer on three production Rust services and reviewer on three more in a decentralized cloud platform. That scope is the reason I am applying to a team where backend systems are the product.';
const P2 = 'The strongest evidence is a rewrite. I profiled two Java middleware components, replaced them with Rust, and measured a 75% gain in core performance. Alongside that work, five Spring services moved from Java 11 to Java 17 and shipped together in one coordinated release. A second engineer reviewed each step before merge. The suite of more than 1,250 unit tests kept 100% coverage through every change, which let reviewers merge with confidence.';
const P3 = 'In this role I aim to own a service end to end: its interfaces, its failure modes and its release path. I want to work where Rust or Java systems carry the product, because that is where design decisions have visible consequences. Rust is my first choice, and Java is an equal one. Your team will see the same habits from me that the iExec work shows: small changes, measured results and tests that stay green.';
const P4 = 'My availability starts on 29 October 2026, and Basel is within daily reach. As a French citizen I am eligible to work in Switzerland under EU-CH free movement. I look forward to an interview, where I will present these services in more detail. My CV is attached, and diplomas, certificates and references are available on request.';
const FR1 = "Exemple SA développe des logiciels de conformité pour les banques suisses, et votre annonce de développeur backend décrit une équipe qui exploite ses propres services, de la conception à la production. Depuis février 2024, je suis développeur principal de trois services Rust en production et relecteur de trois autres au sein d'une plateforme de cloud décentralisé. Cette responsabilité explique ma candidature auprès d'une équipe dont le produit repose sur des systèmes backend.";
const FR2 = "La preuve la plus solide est une réécriture. J'ai profilé deux composants Java, puis je les ai remplacés par du Rust, avec un gain de 75% sur la performance du cœur. En parallèle, cinq services Spring sont passés de Java 11 à Java 17 et ont été livrés ensemble dans une version coordonnée. Un second ingénieur relisait chaque étape avant la fusion. Les plus de 1 250 tests unitaires ont conservé 100% de couverture à chaque changement, ce qui permettait aux relecteurs de fusionner en confiance.";
const FR3 = "Dans ce poste, je vise la responsabilité d'un service de bout en bout : ses interfaces, ses modes de défaillance et son chemin de livraison. Je souhaite travailler là où des systèmes Rust ou Java portent le produit, parce que les décisions de conception y ont des conséquences visibles. Rust est mon premier choix, et Java en est un second de même rang. Votre équipe retrouvera chez moi les habitudes que montre le travail chez iExec : des changements petits, des résultats mesurés et des tests qui restent verts.";
const FR4 = "Ma disponibilité commence le 29 octobre 2026, et Bâle se trouve à portée quotidienne. Citoyen français, je peux travailler en Suisse dans le cadre de la libre circulation UE-AELE. Je me réjouis d'un entretien, où je présenterai ces services plus en détail. Mon CV est joint, et les diplômes, certificats et références sont disponibles sur demande.";

const wrapEn = (paragraphs) => ['Dear Example AG team,', '', ...paragraphs.flatMap((p) => [p, '']), 'Kind regards,', 'Jane Example'].join('\n');
const wrapFr = (paragraphs) => ['Madame, Monsieur,', '', ...paragraphs.flatMap((p) => [p, '']), 'Veuillez agréer, Madame, Monsieur, mes meilleures salutations.', 'Jane Example'].join('\n');

test('the clean English letter and email have no findings in kinds letter and email', () => {
  assert.deepEqual(scanText(wrapEn([P1, P2, P3, P4]), { kind: 'letter', lang: 'en' }).findings, []);
  assert.deepEqual(scanText(wrapEn([P1, P3, P4]), { kind: 'email', lang: 'en' }).findings, []);
});

test('the clean French letter has no findings in kind letter, lang fr', () => {
  assert.deepEqual(scanText(wrapFr([FR1, FR2, FR3, FR4]), { kind: 'letter', lang: 'fr' }).findings, []);
});

test('voice-dna precedence: parentheses, uniform sentence length and a direct question are never findings', () => {
  assert.deepEqual(ids('I am eligible to work in Switzerland (permit G as a frontalier) from October.', { kind: 'email', lang: 'en' }), []);
  const uniform = Array.from({ length: 6 }, (_, i) => `Service number ${i + 1} ships with a short release cycle and tests.`).join(' ');
  assert.deepEqual(ids(uniform, { kind: 'email', lang: 'en' }), []);
  assert.deepEqual(ids('Which stack does the Developer Team work in?', { kind: 'email', lang: 'en' }), []);
});

test('kind exemptions: rule 10 stays a reading check, bullets and arrows follow the kind', () => {
  const { findings, skipped } = scanText('Plain text.', { kind: 'email' });
  assert.deepEqual(findings, []);
  assert.ok(skipped.some((s) => s.id === '10'));
  assert.equal(has('- item one\n- item two', '34', { kind: 'answer' }), false);
  assert.equal(has('- item one\n- item two', '34', { kind: 'cv' }), false);
  assert.equal(has('Jenkins → GitHub Actions on all services.', '33', { kind: 'email' }), true);
  assert.equal(has('Jenkins → GitHub Actions on all services.', '33', { kind: 'cv' }), false);
});
