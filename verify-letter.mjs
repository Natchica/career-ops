#!/usr/bin/env node
/**
 * verify-letter.mjs — warn-only check of a cover letter or application email
 * body against the letter contract in voice-dna.md §1 (jobup.ch cover-letter
 * guidance, read 2026-10-21). Zero network, zero model.
 *
 *   node verify-letter.mjs <body.txt | payload.json> [--kind letter|email] [--lang en|fr] [--company <name>]
 *
 * It reports findings and exits 0, whether or not it found any: the fact gate
 * (verify-cv-facts.mjs) stays the only hard gate. Exit 1 means a usage error or
 * unreadable input.
 */

import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

export const WORD_BUDGET = { letter: [250, 350], email: [150, 250] };

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"«(])/u;
const HEADER_LINE = /^\s*(?:Subject|Objet|Annexes?)\s*:/i;
const SALUTATION = /^(?:Dear|Hello|Madame|Monsieur|Bonjour|Sehr geehrte|Guten Tag)\b.*,\s*$/i;
const VALEDICTION = /^(?:Kind regards|Best regards|Regards|Sincerely|Yours (?:sincerely|faithfully)|Veuillez agréer|Je vous prie d['’]agréer|Meilleures salutations|Cordialement|Mit freundlichen Grüssen|Freundliche Grüsse)/i;

const EN = {
  conditional: /(?<![\p{L}-])(?:would|could|might|should)(?![\p{L}-])/giu,
  negative: /(?<![\p{L}-])(?:not|never|cannot)(?![\p{L}-])|(?<![\p{L}-])\w+n['’]t(?![\p{L}-])|(?<![\p{L}-])no\s+(?=[a-z])/giu,
  initial: /^I(?![\p{L}'’-])/u,
  objective: /(?<![\p{L}-])(?:aims?|wants?|will|plans?|intends?)(?![\p{L}-])/iu,
  cta: /(?<![\p{L}-])interviews?(?![\p{L}-])/iu,
  contraction: /(?<![\p{L}-])\w+n['’]t(?![\p{L}-])|(?<![\p{L}-])(?:I|you|we|they|he|she|it)['’](?:m|re|ve|ll|d)(?![\p{L}-])|(?<![\p{L}-])(?:it|that|there|here|what|let|who)['’]s(?![\p{L}-])/giu,
  posting: /(?<![\p{L}-])(?:your|the) (?:job )?(?:posting|advertisement|vacancy|opening)(?![\p{L}-])/iu,
  filler: /^(?:I am (?:writing|pleased|excited|delighted|thrilled|happy|glad)\b|Please find\b|Allow me\b|My name is\b|I hope this\b)/i,
};

// French conditional: an -er verb's -ais/-ait/-ions/-iez/-aient on the bare infinitive, or an
// irregular / -re / -ir stem taken whole (the lookbehind anchors it, so "tirais" cannot match
// the stem "ir"). A generic "-rais" suffix would catch every imperfect of a verb whose stem ends in r.
const FR_COND_STEMS = ['aur', 'saur', 'pourr', 'devr', 'voudr', 'faudr', 'vaudr', 'verr', 'enverr', 'recevr',
  'viendr', 'tiendr', 'conviendr', 'deviendr', 'obtiendr', 'prendr', 'apprendr', 'comprendr', 'mettr', 'permettr',
  'rendr', 'attendr', 'plair', 'ir', 'dir', 'écrir', 'construir', 'conduir', 'produir', 'choisir', 'réussir',
  'finir', 'offrir', 'ouvrir', 'partir', 'servir', 'sortir'];
const FR = {
  initial: /^(?:je(?!\p{L})|j['’])/iu,
  filler: /^(?:je me permets|je vous écris|par la présente|c['’]est avec|suite à votre annonce|permettez-moi|je m['’]appelle)(?!\p{L})/iu,
  objective: /(?<!\p{L})(?:souhaite|vise|compte|vais|veux|ambitionne)(?!\p{L})/iu,
  cta: /(?<!\p{L})entretiens?(?!\p{L})/iu,
  posting: /(?<!\p{L})(?:votre|l['’])\s*(?:annonce|offre d['’]emploi)(?!\p{L})/iu,
  negative: /(?<!\p{L})(?:jamais|aucune?)(?!\p{L})|(?<!\p{L})(?:ne\s+|n['’])(?:[\p{L}'’]+\s+){0,3}(?:pas|plus|rien|guère)(?!\p{L})/giu,
  conditional: new RegExp(String.raw`(?<!\p{L})(?:\p{L}+er|${FR_COND_STEMS.join('|')})(?:ais|ait|ions|iez|aient)(?!\p{L})`, 'giu'),
};
const NEVER = /(?!)/gu; // French has no contraction check: elision (j'ai, l'équipe) is ordinary writing
const RULES = {
  en: EN,
  fr: { ...EN, ...FR, contraction: NEVER },
};

// jobup's stock phrases ("Je suis dynamique et très motivé"), applied in both languages.
export const STOCK = ['dynamic', 'motivated', 'team player', 'I am writing to', 'pleased to', 'dynamique', 'motivé', 'motivée', 'je vous écris', "c'est avec plaisir que"];
// Fallback for a checkout without voice-dna.md: a subset of its section 3 lists.
export const BUILTIN_BANNED = {
  words: ['delve', 'realm', 'harness', 'unlock', 'tapestry', 'paradigm', 'cutting-edge', 'leverage', 'synergy', 'innovative', 'game-changer', 'showcase', 'foster', 'holistic', 'seamless', 'robust', 'streamline', 'empower', 'elevate', 'crucial', 'pivotal', 'meticulous'],
  phrases: ["in today's", 'it is important to note', 'in order to', 'at the end of the day', 'moving forward', 'furthermore', 'additionally', 'moreover', 'that said', 'that being said', 'with that in mind', 'on top of that'],
};

const escapeRe = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/\s+/g, '\\s+');
const termRe = (terms) => new RegExp(`(?<![\\p{L}-])(?:${terms.map(escapeRe).join('|')})(?![\\p{L}-])`, 'giu');
const STOCK_RE = termRe(STOCK);

// Words that only German uses, from the one B1 sentence voice-dna.md allows plus its cousins.
const DE_WORDS = new Set(['ich', 'und', 'nicht', 'mein', 'meine', 'meinen', 'weiter', 'weiterhin', 'lerne', 'lernen', 'deutsch', 'deutschkenntnisse', 'zum', 'zur', 'mit', 'auf', 'ist', 'bin', 'habe', 'sie', 'ihnen', 'freue', 'möchte', 'bis', 'das', 'erreichen', 'strebe']);

/** A sentence is German when it has at least 2 distinct German markers; an umlaut or ß counts as one. */
export function isGermanSentence(sentence) {
  const hits = new Set((String(sentence).toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => DE_WORDS.has(w)));
  if (/[äöüß]/i.test(sentence)) hits.add('umlaut');
  return hits.size >= 2;
}

const LEGAL_SUFFIX = /\s+(?:AG|SA|S\.A\.|GmbH|Sàrl|SARL|SAS|Ltd\.?|Inc\.?|LLC)$/i;

/** Does paragraph 1 name the company (legal suffix stripped) or the posting? */
function namesCompany(paragraph, company, postingRe) {
  if (postingRe.test(paragraph)) return true;
  const name = String(company).trim().replace(LEGAL_SUFFIX, '').trim();
  if (!name) return true;
  return termRe([name]).test(paragraph);
}

const MARKER = /\[confirm[^\]]*\]/gi;
const EM_DASH = /\u2014|\s\u2013\s/g;

const FR_MARK = /(?<![\p{L}-])(?:le|la|les|je|j['’]|vous|nous|des|une|est|pour|avec)(?![\p{L}-])/giu;
const EN_MARK = /(?<![\p{L}-])(?:the|and|i|you|we|of|to|is|with|for)(?![\p{L}-])/giu;

/** 'fr' when French function words outnumber English ones, else 'en'. */
export function detectLang(text) {
  const t = String(text ?? '');
  return (t.match(FR_MARK) ?? []).length > (t.match(EN_MARK) ?? []).length ? 'fr' : 'en';
}

const unique = (re, sentences) => [...new Set(sentences.flatMap((s) => [...s.matchAll(re)].map((m) => m[0].toLowerCase())))];

const isWord = (token) => /[\p{L}\p{N}]/u.test(token);
const wordCount = (sentences) => sentences.reduce((n, s) => n + s.split(/\s+/).filter(isWord).length, 0);

/**
 * Cut the letter body out of a text: drop Subject/Objet/Annexes lines, a leading
 * salutation, and the first valediction line with everything after it, then
 * split the rest into paragraphs of sentences. German sentences (the one B1
 * line) are left out: every language rule and the word count skip them.
 * @param {string} text
 * @returns {{paragraphs: string[][]}}
 */
export function splitBody(text) {
  let lines = String(text ?? '').split(/\r?\n/).filter((line) => !HEADER_LINE.test(line));
  const cut = lines.findIndex((line) => VALEDICTION.test(line.trim()));
  if (cut !== -1) lines = lines.slice(0, cut);
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first !== -1 && SALUTATION.test(lines[first].trim())) lines = lines.slice(first + 1);

  const paragraphs = lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((block) => block.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s && !isGermanSentence(s)))
    .filter((sentences) => sentences.length > 0);
  return { paragraphs };
}

/**
 * @param {string} text a letter or email body, salutation and signature included
 * @param {{kind?: 'letter'|'email', lang?: 'en'|'fr', company?: string, bannedLists?: object}} [opts]
 * @returns {{code: string, message: string}[]}
 */
export function checkLetter(text, { kind = 'email', lang, company, bannedLists = BUILTIN_BANNED } = {}) {
  const rules = RULES[lang ?? detectLang(text)] ?? EN;
  const findings = [];
  const add = (code, message) => findings.push({ code, message });

  const whole = String(text ?? '');
  const { paragraphs } = splitBody(text);
  const sentences = paragraphs.flat();
  if (sentences.length === 0) {
    add('empty-body', 'There is no letter body to check.');
    return findings;
  }

  const [min, max] = WORD_BUDGET[kind] ?? WORD_BUDGET.email;
  const words = wordCount(sentences);
  if (words < min || words > max) {
    add('word-count', `The body has ${words} words; a ${kind} takes ${min}-${max}.`);
  }

  const conditionals = unique(rules.conditional, sentences);
  if (conditionals.length) {
    add('conditional', `Conditional forms (${conditionals.join(', ')}); state it directly, in the present or the future.`);
  }

  if (company && !namesCompany(paragraphs[0].join(' '), company, rules.posting)) {
    add('missing-company-reference', `Paragraph 1 names neither ${company} nor the posting; open with one verifiable fact about them.`);
  }

  const stock = unique(STOCK_RE, sentences);
  if (stock.length) {
    add('stock-phrase', `Stock phrases (${stock.join(', ')}); replace each with a concrete example.`);
  }

  const stockFolded = new Set(STOCK.map((t) => t.toLowerCase()));
  const banned = [...new Set([...(bannedLists.words ?? []), ...(bannedLists.phrases ?? [])]
    .filter((t) => t && !stockFolded.has(t.toLowerCase())))];
  const bannedFound = banned.length ? unique(termRe(banned), sentences) : [];
  if (bannedFound.length) {
    add('banned-word', `Banned wording from voice-dna.md (${bannedFound.join(', ')}); use a plain word.`);
  }

  const fillers = paragraphs.map((p) => p[0]).filter((first) => rules.filler.test(first));
  if (fillers.length) {
    add('filler-opener', `A paragraph opens with filler ("${fillers[0].split(/\s+/).slice(0, 4).join(' ')}"); open with the company, the system or the number.`);
  }

  // Paragraph roles: 4 paragraphs put the objective in the 3rd; 3 or 5+ search the
  // middle ones; fewer than 3 search the whole body. The call to action is the last paragraph.
  const n = paragraphs.length;
  const objectiveScope = n === 4 ? [paragraphs[2]] : n >= 3 ? paragraphs.slice(1, -1) : paragraphs;
  if (!rules.objective.test(objectiveScope.flat().join(' '))) {
    add('missing-objective', 'No forward-looking objective (aim, want, will, plan); say what you want to do in this role.');
  }
  if (!rules.cta.test(paragraphs[n - 1].join(' '))) {
    add('missing-cta', 'The last paragraph does not ask for an interview.');
  }

  const negatives = unique(rules.negative, sentences);
  if (negatives.length) {
    add('negative-formulation', `Negative formulations (${negatives.join(', ')}); say what the evidence covers instead.`);
  }

  const initial = sentences.filter((s) => rules.initial.test(s)).length;
  if (initial * 3 > sentences.length) {
    add('sentence-initial-i', `${initial}/${sentences.length} sentences open with "I"; keep it to one third and open with the company, the system or the number.`);
  }

  const contractions = unique(rules.contraction, sentences);
  if (contractions.length) {
    add('contraction', `Contractions (${contractions.join(', ')}); write the full form.`);
  }

  // These scan the whole input, so "Dear [confirm name]," in the salutation is caught.
  const markers = [...whole.matchAll(MARKER)].map((m) => m[0]);
  if (markers.length) {
    add('unconfirmed-marker', `Unresolved marker ${markers[0]}; confirm it or remove it before sending.`);
  }
  if (EM_DASH.test(whole)) add('em-dash', 'An em dash; use a comma, a colon, a semicolon or parentheses.');
  if (whole.includes('!')) add('exclamation', 'An exclamation mark; state it plainly.');
  return findings;
}

const USAGE = `Usage: node verify-letter.mjs <body.txt | payload.json> [--kind letter|email] [--lang en|fr] [--company <name>]

Warn-only check of a cover letter or application email against the voice-dna.md
section 1 letter contract. Prints each finding and exits 0; exits 1 only on a
usage error or unreadable input.

Options:
  --kind <letter|email>  Word budget and defaults (letter 250-350 words, email 150-250)
  --lang <en|fr>         Language rules; detected from the text when absent
  --company <name>       The employer, for the paragraph 1 company check
  --help, -h             This message
`;

const KNOWN_FLAGS = ['--kind', '--lang', '--company', '--help', '-h'];
const VALUE_FLAGS = ['--kind', '--lang', '--company'];

export function runCli(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  console.error('Error: the verify-letter CLI is not wired yet.');
  process.exit(1);
}

if (isMainModule(import.meta.url)) runCli(process.argv.slice(2));
