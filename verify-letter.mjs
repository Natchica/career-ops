#!/usr/bin/env node
/**
 * verify-letter.mjs — warn-only check of a cover letter or application email
 * body against the letter contract in voice-dna.md §1 (jobup.ch cover-letter
 * guidance, read 2026-10-21). Zero network, zero model.
 *
 *   node verify-letter.mjs <body.txt | payload.json> [--kind letter|email] [--lang en|fr] [--company <name>]
 *
 * It also runs the unslop.mjs scan and merges the findings by cause. Exit 0: no block
 * finding (warnings may exist). Exit 2: a block finding (a banned word, a contraction,
 * an em dash, an exclamation mark, or a block slop rule). Exit 1: a usage error or
 * unreadable input. The fact gate (verify-cv-facts.mjs) stays the only fact check.
 */

import { isMainModule } from './lib/is-main-module.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { scanText } from './unslop.mjs';
import { detectLang, isGermanSentence, normTerm, splitParagraphs, termRe, wordCount } from './lib/letter-text.mjs';

export { detectLang, isGermanSentence };

export const WORD_BUDGET = { letter: [250, 350], email: [150, 250] };

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

const STOCK_RE = termRe(STOCK);

const LEGAL_SUFFIX = /\s+(?:AG|SA|S\.A\.|GmbH|Sàrl|SARL|SAS|Ltd\.?|Inc\.?|LLC)$/i;

/** Does paragraph 1 name the company (legal suffix stripped) or the posting? */
function namesCompany(paragraph, company, postingRe) {
  if (postingRe.test(paragraph)) return true;
  const name = String(company).trim().replace(LEGAL_SUFFIX, '').trim();
  if (!name) return true;
  return termRe([name]).test(paragraph);
}

// Findings the voice-dna.md section 2 and 3 rules make hard: a banned word, a contraction, an em dash, an exclamation mark.
const SEVERITY = { 'banned-word': 'block', contraction: 'block', 'em-dash': 'block', exclamation: 'block' };

const MARKER = /\[confirm[^\]]*\]/gi;
const EM_DASH = /\u2014|\s\u2013\s/g;

/** The text of one voice-dna.md section 3 subsection, from its heading to the next heading or rule. */
function sectionOf(md, letter) {
  const start = md.search(new RegExp(`^### 3${letter}\\.`, 'm'));
  if (start === -1) return null;
  const rest = md.slice(start).replace(/^[^\n]*\n/, '');
  const end = rest.search(/^(?:### |---\s*$)/m);
  return end === -1 ? rest : rest.slice(0, end);
}

const quoted = (text) => [...text.replace(/\([^)]*\)/g, '').matchAll(/"([^"]+)"/g)]
  .map((m) => m[1].split('[')[0].replace(/[\s,.\u2026]+$/, '').trim())
  .filter((p) => p.length >= 2);

/**
 * Read the banned words (3A list line) and banned phrases (quoted text in 3A "Also banned",
 * 3B and 3C) out of voice-dna.md. Null when a section is missing or yields nothing.
 * @param {string} md
 * @returns {{words: string[], phrases: string[]}|null}
 */
export function parseVoiceDna(md) {
  const [a, b, c] = ['A', 'B', 'C'].map((letter) => sectionOf(String(md ?? ''), letter));
  if (a == null || b == null || c == null) return null;

  const commaCount = (line) => (line.match(/,/g) ?? []).length;
  const wordsLine = a.split('\n').reduce((best, line) => (commaCount(line) > commaCount(best) ? line : best), '');
  const words = commaCount(wordsLine) < 10 ? [] : wordsLine
    .split(/[,/]/)
    .map((w) => w.replace(/\([^)]*\)/g, '').trim())
    .filter(Boolean);

  const alsoBanned = a.split('\n').find((line) => /^Also banned/i.test(line)) ?? '';
  const phrases = [...new Set([...quoted(alsoBanned.split(/ when /i)[0]), ...quoted(b), ...quoted(c)])];
  if (words.length === 0 || phrases.length === 0) return null;
  return { words, phrases };
}

/**
 * The banned lists to check against: voice-dna.md under the data root when it parses, otherwise the
 * built-in subset, with a one-line note saying why.
 * @returns {{lists: {words: string[], phrases: string[]}, note: string|null}}
 */
export function loadBannedLists(root = getCareerOpsRoot()) {
  let md;
  try {
    md = readFileSync(join(root, 'voice-dna.md'), 'utf-8');
  } catch {
    return { lists: BUILTIN_BANNED, note: 'voice-dna.md not found; using the built-in banned list.' };
  }
  const lists = parseVoiceDna(md);
  if (!lists) return { lists: BUILTIN_BANNED, note: 'voice-dna.md has no parsable section 3; using the built-in banned list.' };
  return { lists, note: null };
}

const unique = (re, sentences) => [...new Set(sentences.flatMap((s) => [...s.matchAll(re)].map((m) => m[0].toLowerCase())))];

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

  const paragraphs = splitParagraphs(lines.join('\n'));
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
  const add = (code, message, terms) => findings.push({ code, severity: SEVERITY[code] ?? 'warn', message, ...(terms ? { terms } : {}) });

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
    add('stock-phrase', `Stock phrases (${stock.join(', ')}); replace each with a concrete example.`, stock.map(normTerm));
  }

  const stockFolded = new Set(STOCK.map((t) => t.toLowerCase()));
  const banned = [...new Set([...(bannedLists.words ?? []), ...(bannedLists.phrases ?? [])]
    .filter((t) => t && !stockFolded.has(t.toLowerCase())))];
  const bannedFound = banned.length ? unique(termRe(banned), sentences) : [];
  if (bannedFound.length) {
    add('banned-word', `Banned wording from voice-dna.md (${bannedFound.join(', ')}); use a plain word.`, bannedFound.map(normTerm));
  }

  const fillers = paragraphs.map((p) => p[0]).filter((first) => rules.filler.test(first));
  if (fillers.length) {
    add('filler-opener', `A paragraph opens with filler ("${fillers[0].split(/\s+/).slice(0, 4).join(' ')}"); open with the company, the system or the number.`, fillers.map((first) => normTerm(rules.filler.exec(first)?.[0] ?? '')).filter(Boolean));
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
  const dashes = [...whole.matchAll(EM_DASH)].map((m) => normTerm(m[0].trim()));
  if (dashes.length) add('em-dash', 'An em dash; use a comma, a colon, a semicolon or parentheses.', [...new Set(dashes)]);
  if (whole.includes('!')) add('exclamation', 'An exclamation mark; state it plainly.');
  return findings;
}

const coveredBy = (term, covered) => {
  const t = normTerm(term);
  return covered.find((c) => c.term === t || (c.term.length >= 4 && t.length >= 4 && (t.includes(c.term) || c.term.includes(t))));
};

/**
 * Merge the letter-contract findings with the unslop scan, one finding per cause. A slop match whose
 * term a letter finding already carries (an em dash, a banned word, a stock phrase, a filler opener)
 * is dropped, and the letter finding takes the higher of the two severities. A cluster loses the hits
 * a letter finding covers and is dropped below two hits.
 */
function mergeByCause(letter, slop) {
  const covered = letter.flatMap((f) => (f.terms ?? []).map((term) => ({ term, finding: f })));
  const raise = (finding, severity) => { if (severity === 'block') finding.severity = 'block'; };
  const merged = [];
  for (const s of slop) {
    if (s.id === 'empty-text' && letter.some((f) => f.code === 'empty-body')) continue;
    if (s.hits) {
      const kept = s.hits.filter((hit) => {
        const c = coveredBy(hit, covered);
        if (c) raise(c.finding, s.severity);
        return !c;
      });
      if (kept.length < 2) continue;
      merged.push({ code: `unslop-${s.id}`, severity: s.severity, message: `${s.name}: "${kept.join(', ')}"` });
      continue;
    }
    const c = coveredBy(s.term, covered);
    if (c) { raise(c.finding, s.severity); continue; }
    merged.push({ code: `unslop-${s.id}`, severity: s.severity, message: `${s.name}: "${s.term}"${s.hint ? ` (${s.hint})` : ''}` });
  }
  return [...letter, ...merged];
}

/**
 * The letter contract (checkLetter) plus the unslop scan, merged by cause. Block findings make the CLI exit 2.
 * @param {string} text
 * @param {{kind?: 'letter'|'email', lang?: 'en'|'fr', company?: string, bannedLists?: object, rules?: object[]}} [opts]
 * @returns {{code: string, severity: 'block'|'warn', message: string}[]}
 */
export function verifyLetter(text, { kind = 'email', lang, company, bannedLists, rules } = {}) {
  const resolved = lang ?? detectLang(text);
  const letter = checkLetter(text, { kind, lang: resolved, company, ...(bannedLists ? { bannedLists } : {}) });
  const { findings: slop } = scanText(text, { kind, lang: resolved, rules });
  return mergeByCause(letter, slop);
}

const USAGE = `Usage: node verify-letter.mjs <body.txt | payload.json> [--kind letter|email] [--lang en|fr] [--company <name>]

Check of a cover letter or application email against the voice-dna.md section 1
letter contract, plus the unslop.mjs scan. Prints each finding. Exit 0: no block
finding. Exit 2: a block finding. Exit 1: a usage error or unreadable input.

Options:
  --kind <letter|email>  Word budget and defaults (letter 250-350 words, email 150-250)
  --lang <en|fr>         Language rules; detected from the text when absent
  --company <name>       The employer, for the paragraph 1 company check
  --help, -h             This message
`;

const KNOWN_FLAGS = ['--kind', '--lang', '--company', '--help', '-h'];
const VALUE_FLAGS = ['--kind', '--lang', '--company'];

/**
 * The letter text a cover payload renders, in reading order: greeting, opening, profile_intro,
 * problems_section, closing, language_closing. The greeting must end with a comma, the shape
 * cover.md writes, for splitBody to recognise it as a salutation.
 */
export function payloadToText(payload) {
  const letter = payload?.letter ?? {};
  return [letter.greeting, letter.opening, letter.profile_intro, letter.problems_section, letter.closing, letter.language_closing]
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n\n');
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function runCli(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) positionals.push(args[i]);
  }
  const [input] = positionals;
  if (!input) fail('give the body file: node verify-letter.mjs <body.txt | payload.json> [--kind letter|email] [--lang en|fr] [--company <name>]');
  if (!existsSync(input)) fail(`file not found: ${input}`);

  let text;
  try {
    text = readFileSync(input, 'utf-8');
  } catch (e) {
    fail(`cannot read ${input}: ${e.message}`);
  }

  // A .json input is a cover payload (a letter); anything else is a plain-text body (an email by default).
  let payload = null;
  if (input.toLowerCase().endsWith('.json')) {
    try {
      payload = JSON.parse(text);
    } catch (e) {
      fail(`${input} is not valid JSON: ${e.message}`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) fail(`${input} must hold a JSON object`);
    text = payloadToText(payload);
  }

  const kind = flagValue(args, '--kind') ?? (payload ? 'letter' : 'email');
  if (!Object.hasOwn(WORD_BUDGET, kind)) fail('--kind must be letter or email');
  const lang = flagValue(args, '--lang');
  if (lang !== undefined && !Object.hasOwn(RULES, lang)) fail('--lang must be en or fr');
  const company = flagValue(args, '--company') ?? payload?.letter?.company;
  if (!company) console.error('Note: no --company and no letter.company; the paragraph 1 company check was skipped.');
  const { lists, note } = loadBannedLists();
  if (note) console.error(note);

  const findings = verifyLetter(text, { kind, lang, company, bannedLists: lists });
  if (findings.length === 0) {
    console.log('Letter check passed: no findings.');
    return;
  }
  const blocks = findings.filter((f) => f.severity === 'block').length;
  const count = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  console.log(blocks > 0 ? `Letter check: ${count}, ${blocks} block` : `Letter check: ${count} (warn-only)`);
  for (const f of findings) console.log(`  ${f.severity === 'block' ? '\u2716' : '\u26A0'} ${f.code}: ${f.message}`);
  if (blocks > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) runCli(process.argv.slice(2));
