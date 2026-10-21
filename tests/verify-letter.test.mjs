// tests/verify-letter.test.mjs — warn-only letter checker (voice-dna.md §1 contract).
// All fixtures are fictional (Jane Example, Example AG). Unit tests inject their own banned lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_BANNED, checkLetter, detectLang, isGermanSentence, splitBody } from '../verify-letter.mjs';

const P1 = 'Example AG builds compliance software for Swiss banks, and your posting for a Backend Engineer describes a team that runs its own services from design to production. Since February 2024 I have been lead developer on three production Rust services and reviewer on three more in a decentralized cloud platform. That scope is the reason I am applying to a team where backend systems are the product.';
const P2 = 'The strongest evidence is a rewrite. I profiled two Java middleware components, replaced them with Rust, and measured a 75% gain in core performance. Alongside that work, five Spring services moved from Java 11 to Java 17 and shipped together in one coordinated release. A second engineer reviewed each step before merge. The suite of more than 1,250 unit tests kept 100% coverage through every change, which let reviewers merge with confidence.';
const P3 = 'In this role I aim to own a service end to end: its interfaces, its failure modes and its release path. I want to work where Rust or Java systems carry the product, because that is where design decisions have visible consequences. Rust is my first choice, and Java is an equal one. Your team will see the same habits from me that the iExec work shows: small changes, measured results and tests that stay green.';
const P4 = 'My availability starts on 29 October 2026, and Basel is within daily reach. As a French citizen I am eligible to work in Switzerland under EU-CH free movement. I look forward to an interview, where I will present these services in more detail. My CV is attached, and diplomas, certificates and references are available on request.';

const wrap = (paragraphs) => ['Dear Example AG team,', '', ...paragraphs.flatMap((p) => [p, '']), 'Kind regards,', 'Jane Example', 'jane@example.com'].join('\n');
const CLEAN_EN_LETTER = wrap([P1, P2, P3, P4]);
const codes = (text, opts) => checkLetter(text, opts).map((f) => f.code);
const LETTER = { kind: 'letter', lang: 'en', company: 'Example AG' };

test('an empty body gives exactly empty-body', () => {
  for (const text of ['', '   \n', 'Dear X,\n\nKind regards,\nJane']) {
    assert.deepEqual(codes(text, LETTER), ['empty-body']);
  }
});

test('a clean English letter has no findings', () => {
  assert.deepEqual(checkLetter(CLEAN_EN_LETTER, LETTER), []);
});

test('the word budget follows kind: letter 250-350, email 150-250', () => {
  assert.deepEqual(codes(CLEAN_EN_LETTER, { ...LETTER, kind: 'email' }), ['word-count']);
  const short = wrap([P1, P4]);
  assert.deepEqual(codes(short, LETTER), ['word-count']);
  assert.deepEqual(codes(short, { ...LETTER, kind: 'email' }), ['word-count']);
});

test('salutation, subject, valediction and signature lines are outside the word count', () => {
  const padded = ['Subject: Application: Backend Engineer', '', CLEAN_EN_LETTER, 'Annexes: CV'].join('\n');
  assert.deepEqual(checkLetter(padded, LETTER), []);
});

const swap = (from, to, base = CLEAN_EN_LETTER) => {
  assert.ok(base.includes(from), `fixture does not contain "${from}"`);
  return base.replace(from, to);
};

test('English conditionals are flagged by word', () => {
  assert.deepEqual(codes(swap('will present', 'would present'), LETTER), ['conditional']);
  assert.deepEqual(codes(swap('will see', 'might see'), LETTER), ['conditional']);
  const both = checkLetter(swap('will see', 'should see', swap('will present', 'could present')), LETTER);
  assert.deepEqual(both.map((f) => f.code), ['conditional']);
  assert.match(both[0].message, /could/);
  assert.match(both[0].message, /should/);
});

test('English negative formulations are flagged', () => {
  const cases = [
    ['A second engineer reviewed', 'A second engineer, not a bot, reviewed'],
    ['kept 100% coverage', 'never dropped 100% coverage'],
    ['merge with confidence', 'merge, because nobody cannot trust it'],
    ['I aim to own', 'I aim to own, with no experience gap,'],
  ];
  for (const [from, to] of cases) {
    assert.deepEqual(codes(swap(from, to), LETTER), ['negative-formulation'], to);
  }
  // "don't" is both a negative formulation and a contraction.
  assert.deepEqual(codes(swap('Alongside that work', "Alongside that work, we don't wait"), LETTER), ['negative-formulation', 'contraction']);
  for (const [from, to] of [['A second engineer', 'Notably a second engineer'], ['Alongside that work', 'Alongside that no-code work'], ['Spring services', 'Spring knot services']]) {
    assert.deepEqual(codes(swap(from, to), LETTER), [], to);
  }
});

test('more than one third of sentences opening with I is flagged, exactly one third is not', () => {
  // 9 sentences in total; the last one always opens with I, so `initial` counts it.
  const nine = (initial) => {
    const sentences = [];
    for (let i = 0; i < 8; i += 1) {
      sentences.push(i < initial - 1
        ? `I built part ${i + 1} of the Example AG service with measured results and a short release cycle.`
        : `Part ${i + 1} of the Example AG service shipped with measured results and a short release cycle.`);
    }
    sentences.push('I aim to own it, and an interview will cover it.');
    return wrap([sentences.slice(0, 3).join(' '), sentences.slice(3, 6).join(' '), sentences.slice(6).join(' ')]);
  };
  const initialFindings = (text) => checkLetter(text, { kind: 'email', lang: 'en', company: 'Example AG' }).filter((f) => f.code === 'sentence-initial-i');
  assert.deepEqual(initialFindings(nine(3)), []);
  const over = initialFindings(nine(4));
  assert.equal(over.length, 1);
  assert.match(over[0].message, /4\/9/);
});

const GERMAN_B1 = 'Ich lerne weiter Deutsch und strebe das Niveau B2 an.';

test('the German B1 sentence is outside every language rule and the word count', () => {
  assert.equal(isGermanSentence(GERMAN_B1), true);
  assert.equal(isGermanSentence('The team is based in Zürich and works with Rust.'), false);
  assert.equal(isGermanSentence('Mon niveau d’allemand est B1.'), false);
  assert.equal(isGermanSentence('Ich'), false);

  const asParagraph = wrap([P1, P2, P3, P4, GERMAN_B1]);
  assert.deepEqual(splitBody(asParagraph).paragraphs.flat().filter((s) => /Ich lerne/.test(s)), []);
  assert.equal(splitBody(asParagraph).paragraphs.length, 4);
  assert.deepEqual(checkLetter(asParagraph, LETTER), []);

  const inside = wrap([P1, P2, P3, `${P4} ${GERMAN_B1}`]);
  assert.deepEqual(checkLetter(inside, LETTER), []);

  // 345 English words sit inside the 350 budget; counting the 11 German words would break it.
  const filler = `Release ${'release '.repeat(72)}release.`;
  const edge = wrap([P1, P2, P3, filler, P4, GERMAN_B1]);
  assert.deepEqual(checkLetter(edge, LETTER), []);
});

test('stock phrases and filler openers are flagged', () => {
  assert.deepEqual(codes(swap('A second engineer reviewed', 'A second engineer, a team player, reviewed'), LETTER), ['stock-phrase']);
  assert.deepEqual(codes(swap('reviewers merge', 'dynamic reviewers merge'), LETTER), ['stock-phrase']);
  assert.deepEqual(codes(swap('Example AG builds', 'Allow me to explain why Example AG builds'), LETTER), ['filler-opener']);
  assert.deepEqual(codes(swap('My availability starts', 'Please find my availability, which starts'), LETTER), ['filler-opener']);
  // Not at the start of a paragraph's first sentence: a plain use of the words is fine.
  assert.deepEqual(codes(swap('Alongside that work', 'Alongside that work, a motivational speaker'), LETTER), []);
});

test('banned words come from the injected lists, minus stock phrases', () => {
  const lists = { words: ['zorblax'], phrases: ['with that in mind'] };
  const both = checkLetter(swap('Alongside that work', 'With that in mind, alongside that work', swap('Rust is my first choice', 'Zorblax is my first choice')), { ...LETTER, bannedLists: lists });
  assert.deepEqual(both.map((f) => f.code), ['banned-word']);
  assert.match(both[0].message, /zorblax/);
  assert.match(both[0].message, /with that in mind/);

  const stockOnly = checkLetter(swap('reviewers merge', 'dynamic reviewers merge'), { ...LETTER, bannedLists: { words: ['dynamic'], phrases: [] } });
  assert.deepEqual(stockOnly.map((f) => f.code), ['stock-phrase']);

  assert.deepEqual(codes(swap('measured a 75% gain', 'leverage a 75% gain'), LETTER), ['banned-word']);
  assert.ok(BUILTIN_BANNED.words.includes('leverage'));
});

test('paragraph 1 must name the company or the posting; skipped without a company', () => {
  const has = (text, opts) => codes(text, opts).includes('missing-company-reference');
  const sentence = 'Example AG builds compliance software for Swiss banks, and your posting for a Backend Engineer describes a team that runs its own services from design to production.';
  const anonymous = swap(sentence, 'A team runs its own services from design to production, from the first design review to the last release note.');
  assert.equal(has(CLEAN_EN_LETTER, LETTER), false);
  assert.equal(has(anonymous, LETTER), true);
  const posting = swap(sentence, 'Your posting describes a team that runs its own services from design to production, from the first review to the last note.');
  assert.equal(has(posting, LETTER), false);
  const named = swap(sentence, 'Example builds software, and the team runs its own services from design to production, from the first review to the last note.');
  assert.equal(has(named, LETTER), false);
  assert.equal(has(anonymous, { kind: 'letter', lang: 'en' }), false);
});

test('the objective sits in paragraph 3 and the interview request in the last paragraph', () => {
  const noObjective = wrap([P1, P2, 'In this role, the work centres on one service end to end: its interfaces, its failure modes and its release path. Rust and Java systems carry the product there, because that is where design decisions have visible consequences. Rust is my first choice, and Java is an equal one. Your team sees the same habits from me that the iExec work shows: small changes, measured results and tests that stay green.', P4]);
  assert.deepEqual(codes(noObjective, LETTER), ['missing-objective']);
  assert.deepEqual(codes(swap('an interview, where', 'a conversation, where'), LETTER), ['missing-cta']);
  // An objective verb in paragraph 2 does not count when there are 4 paragraphs.
  const misplaced = wrap([P1, `${P2} I aim to own a service end to end.`, noObjective.split('\n\n')[3], P4]);
  assert.ok(codes(misplaced, LETTER).includes('missing-objective'));
});

test('fewer than 4 paragraphs falls back to a wider search for the objective', () => {
  const two = wrap([`${P1} I aim to own a service end to end.`, P4]);
  assert.ok(!codes(two, LETTER).includes('missing-objective'));
  const three = wrap([P1, P3, P4]);
  assert.ok(!codes(three, LETTER).includes('missing-objective'));
  const threeBad = wrap([`${P1} I aim to own a service.`, P2, P4]);
  assert.ok(codes(threeBad, LETTER).includes('missing-objective'));
});

test('unconfirmed markers, em dashes and exclamation marks are flagged anywhere, salutation included', () => {
  assert.deepEqual(codes(swap('Dear Example AG team,', 'Dear [confirm name],'), LETTER), ['unconfirmed-marker']);
  assert.deepEqual(codes(swap('first choice, and', 'first choice — and'), LETTER), ['em-dash']);
  assert.deepEqual(codes(swap('tests that stay green.', 'tests that stay green!'), LETTER), ['exclamation']);
});

test('English contractions are flagged and possessives are not', () => {
  assert.deepEqual(codes(swap('I look forward', "I'm looking forward"), LETTER), ['contraction']);
  assert.deepEqual(codes(swap('that is where', "that's where"), LETTER), ['contraction']);
  assert.deepEqual(codes(swap('A second engineer', "A second engineer on the team's side, at Example AG's platform,"), LETTER), []);
});

test('every finding carries a code and a message', () => {
  const bad = "Furthermore, I would leverage a dynamic team — it's great!";
  const findings = checkLetter(bad, { kind: 'letter', lang: 'en', company: 'Example AG' });
  assert.ok(findings.length >= 6);
  for (const f of findings) {
    assert.equal(typeof f.code, 'string');
    assert.ok(f.code.length > 0);
    assert.equal(typeof f.message, 'string');
    assert.ok(f.message.length > 10);
  }
});

const FR1 = "Exemple SA développe des logiciels de conformité pour les banques suisses, et votre annonce de développeur backend décrit une équipe qui exploite ses propres services, de la conception à la production. Depuis février 2024, je suis développeur principal de trois services Rust en production et relecteur de trois autres au sein d'une plateforme de cloud décentralisé. Cette responsabilité explique ma candidature auprès d'une équipe dont le produit repose sur des systèmes backend.";
const FR2 = "La preuve la plus solide est une réécriture. J'ai profilé deux composants Java, puis je les ai remplacés par du Rust, avec un gain de 75% sur la performance du cœur. En parallèle, cinq services Spring sont passés de Java 11 à Java 17 et ont été livrés ensemble dans une version coordonnée. Un second ingénieur relisait chaque étape avant la fusion. Les plus de 1 250 tests unitaires ont conservé 100% de couverture à chaque changement, ce qui permettait aux relecteurs de fusionner en confiance.";
const FR3 = "Dans ce poste, je vise la responsabilité d'un service de bout en bout : ses interfaces, ses modes de défaillance et son chemin de livraison. Je souhaite travailler là où des systèmes Rust ou Java portent le produit, parce que les décisions de conception y ont des conséquences visibles. Rust est mon premier choix, et Java en est un second de même rang. Votre équipe retrouvera chez moi les habitudes que montre le travail chez iExec : des changements petits, des résultats mesurés et des tests qui restent verts.";
const FR4 = "Ma disponibilité commence le 29 octobre 2026, et Bâle se trouve à portée quotidienne. Citoyen français, je peux travailler en Suisse dans le cadre de la libre circulation UE-AELE. Je me réjouis d'un entretien, où je présenterai ces services plus en détail. Mon CV est joint, et les diplômes, certificats et références sont disponibles sur demande.";
const wrapFr = (paragraphs) => ['Madame, Monsieur,', '', ...paragraphs.flatMap((p) => [p, '']), 'Veuillez agréer, Madame, Monsieur, mes meilleures salutations.', 'Jane Example'].join('\n');
const CLEAN_FR_LETTER = wrapFr([FR1, FR2, FR3, FR4]);
const FR_LETTER = { kind: 'letter', company: 'Exemple SA' };

test('language is detected from le/la/je density and can be overridden', () => {
  assert.equal(detectLang(CLEAN_FR_LETTER), 'fr');
  assert.equal(detectLang(CLEAN_EN_LETTER), 'en');
  assert.equal(detectLang(''), 'en');
});

const frWith = (snippet) => wrapFr([FR1, FR2, FR3.replace('Rust est mon premier choix', `Rust est mon premier choix, ${snippet}, et`), FR4]);
const frHas = (snippet, code, opts = FR_LETTER) => codes(frWith(snippet), opts).includes(code);

test('French conditionals are flagged, imperfects and look-alike nouns are not', () => {
  const positives = ['aurais', 'pourrais', 'voudrais', 'souhaiterais', 'aimerais', 'serais', 'devrais', 'ferais', 'irais',
    'me permettrait', 'vous pourriez', 'nous aimerions', 'il faudrait', 'ils voudraient'];
  for (const word of positives) assert.equal(frHas(word, 'conditional'), true, `${word} should be flagged`);

  const negatives = ["j'encadrais", "j'assurais", 'je gérais', 'il opérait', "j'intégrais", 'je configurais', 'il montrait',
    'je livrais', 'je désirais', 'je tirais', 'frais', 'vrais', 'mais', 'désormais', 'portrait', 'trait', 'extrait', "j'aimais"];
  for (const word of negatives) assert.equal(frHas(word, 'conditional'), false, `${word} should not be flagged`);

  // The language override wins: the same text under English rules has no French conditional check.
  assert.equal(frHas('aurais', 'conditional', { ...FR_LETTER, lang: 'en' }), false);
});

test('French negative formulations are flagged', () => {
  for (const snippet of ["je n'ai pas", "je ne l'ai pas", 'il ne reste plus', 'jamais', 'aucune', "elle n'a rien"]) {
    assert.equal(frHas(snippet, 'negative-formulation'), true, `${snippet} should be flagged`);
  }
  for (const snippet of ['une équipe de plus de 3', 'de plus', 'au Rhône', 'plus de 3 services']) {
    assert.equal(frHas(snippet, 'negative-formulation'), false, `${snippet} should not be flagged`);
  }
});

test('a clean French letter has no findings and Je/J\' count as sentence-initial I', () => {
  assert.deepEqual(checkLetter(CLEAN_FR_LETTER, FR_LETTER), []);

  const nine = (initial) => {
    const sentences = [];
    for (let i = 0; i < 8; i += 1) {
      sentences.push(i < initial - 1
        ? `${i % 2 ? "J'ai" : 'Je'} construit la partie ${i + 1} du service de Exemple SA avec des résultats mesurés et un cycle de livraison court.`
        : `La partie ${i + 1} du service de Exemple SA est livrée avec des résultats mesurés et un cycle de livraison court.`);
    }
    sentences.push('Je vise la responsabilité complète, et un entretien couvrira ce point.');
    return wrapFr([sentences.slice(0, 3).join(' '), sentences.slice(3, 6).join(' '), sentences.slice(6).join(' ')]);
  };
  const initialOnly = (text) => checkLetter(text, FR_LETTER).filter((f) => f.code === 'sentence-initial-i');
  assert.deepEqual(initialOnly(nine(3)), []);
  assert.equal(initialOnly(nine(4)).length, 1);

  const noObjective = FR3.replace("je vise la responsabilité d'un service", "la responsabilité d'un service").replace('Je souhaite travailler là où des systèmes', 'Des systèmes').replace('portent le produit', 'portent le produit là-bas');
  assert.deepEqual(codes(wrapFr([FR1, FR2, noObjective, FR4]), FR_LETTER), ['missing-objective']);
  assert.deepEqual(codes(wrapFr([FR1, FR2, FR3, FR4.replace("d'un entretien", "d'un échange")]), FR_LETTER), ['missing-cta']);
  assert.deepEqual(codes(wrapFr([FR1.replace('Exemple SA développe', "Je me permets de souligner qu'Exemple SA développe"), FR2, FR3, FR4]), FR_LETTER), ['filler-opener']);
});
