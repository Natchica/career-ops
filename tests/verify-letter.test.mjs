// tests/verify-letter.test.mjs — warn-only letter checker (voice-dna.md §1 contract).
// All fixtures are fictional (Jane Example, Example AG). Unit tests inject their own banned lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_BANNED, checkLetter, isGermanSentence, splitBody } from '../verify-letter.mjs';

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
