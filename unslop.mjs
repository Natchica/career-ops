#!/usr/bin/env node
/**
 * unslop.mjs — the Outbound text gate scanner. Offline and deterministic: no
 * network, no model. Checks a text against templates/unslop-rules.yml (the
 * cursor/plugins@unslop rules, plus humanizer patterns) by kind and language,
 * and checks that a repair kept every fact.
 *
 *   node unslop.mjs <file> [--kind letter|email|message|answer|cv|text] [--lang en|fr]
 *   node unslop.mjs --diff <before> <after>
 *
 * Exit 0: no block finding. Exit 2: a block finding (or a failed --diff).
 * Exit 1: a usage error, unreadable input or an invalid rules file.
 * voice-dna.md section 1-2 win over every rule: see must_not_flag in the rules file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from './lib/yaml-document.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { detectLang, isWord, normTerm, splitParagraphs, termRe } from './lib/letter-text.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const KINDS = ['letter', 'email', 'message', 'answer', 'cv', 'text'];
export const LANGS = ['en', 'fr'];
export const SKILLS = ['cursor/plugins@unslop', 'theclaymethod/unslop', 'aboudjem/humanizer'];

/** Detector name -> function(ctx, rule) returning [{term, context, hint?, hits?}]; filled in as rules are added. */
export const UNSLOP_DETECTORS = {};

/** Every regex source a rule carries: patterns per language, plus `except`. */
function patternSources(rule) {
  const out = [];
  for (const list of Object.values(rule.patterns ?? {})) out.push(...list);
  out.push(...(rule.except ?? []));
  return out;
}

const flagsFor = (rule) => (rule.case_sensitive ? 'gmu' : 'gimu');

/** The match plus up to 40 characters either side, on one line. */
function contextAround(subject, index, length) {
  return subject.slice(Math.max(0, index - 40), index + length + 40).replace(/\s+/g, ' ').trim();
}

/** The terms a rule lists for the text's language, plus the shared `all` list. */
const termsFor = (rule, lang, key = 'terms') => [...(rule[key]?.all ?? []), ...(rule[key]?.[lang] ?? [])];

/**
 * Should a match stay a hit? A capitalised word inside a sentence is read as a name (MongoDB Realm)
 * unless it opens the sentence; a match whose 40-character window fits an `except` pattern is a
 * literal use (vector database).
 */
function keepHit(rule, exceptions, subject, m) {
  if (rule.skip_proper_nouns && /^\p{Lu}/u.test(m[0]) && !/(?:^|[.!?]\s+)$/.test(subject.slice(0, m.index))) return false;
  const window = subject.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
  return !exceptions.some((re) => re.test(window));
}

const exceptionsOf = (rule) => (rule.except ?? []).map((source) => new RegExp(source, 'iu'));
const subjectsOf = (ctx, rule) => (rule.scope === 'text' ? [ctx.text] : ctx.paragraphs);

/** Terms (whole-word, apostrophe-tolerant) and patterns for the text's language, over the rule's scope. */
export function detectMatchList(ctx, rule) {
  const terms = termsFor(rule, ctx.lang);
  const sources = termsFor(rule, ctx.lang, 'patterns');
  const regexes = [...(terms.length ? [termRe(terms)] : []), ...sources.map((source) => new RegExp(source, flagsFor(rule)))];
  const exceptions = exceptionsOf(rule);
  const hits = [];
  for (const subject of subjectsOf(ctx, rule)) {
    for (const re of regexes) {
      for (const m of subject.matchAll(re)) {
        if (m[0] === '' || !keepHit(rule, exceptions, subject, m)) continue;
        hits.push({ term: m[0], context: contextAround(subject, m.index, m[0].length) });
      }
    }
  }
  return hits;
}
UNSLOP_DETECTORS['match-list'] = detectMatchList;

/** One finding per paragraph that holds at least `min_hits` of the listed terms (a cluster, not an isolated tell). */
export function detectCluster(ctx, rule) {
  const terms = termsFor(rule, ctx.lang);
  if (terms.length === 0) return [];
  const re = termRe(terms);
  const exceptions = exceptionsOf(rule);
  const out = [];
  for (const subject of ctx.paragraphs) {
    const hits = [...subject.matchAll(re)].filter((m) => keepHit(rule, exceptions, subject, m)).map((m) => m[0]);
    if (hits.length >= (rule.min_hits ?? 2)) out.push({ term: hits.join(', '), context: subject.slice(0, 120), hits });
  }
  return out;
}
UNSLOP_DETECTORS.cluster = detectCluster;

/** Phrases with a plain replacement; the finding carries the hint `use "x"` or `delete it`. */
export function detectPhraseMap(ctx, rule) {
  const map = rule.map?.[ctx.lang] ?? {};
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return [];
  const replacement = new Map(keys.map((k) => [normTerm(k), map[k]]));
  const re = termRe(keys);
  const exceptions = exceptionsOf(rule);
  const hits = [];
  for (const subject of ctx.paragraphs) {
    for (const m of subject.matchAll(re)) {
      if (!keepHit(rule, exceptions, subject, m)) continue;
      const to = replacement.get(normTerm(m[0]));
      hits.push({ term: m[0], context: contextAround(subject, m.index, m[0].length), hint: to === '' || to == null ? 'delete it' : `use "${to}"` });
    }
  }
  return hits;
}
UNSLOP_DETECTORS['phrase-map'] = detectPhraseMap;

const escapeLiteral = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Agentless passive: an auxiliary plus a regular (-ed, -en) or listed irregular participle, in a sentence
 * with no "by" actor. Adjectival participles (attached, based) and -en words that are not participles
 * (open, citizen) are listed in the rule data; this is a heuristic and the rule is warn only.
 */
export function detectPassive(ctx, rule) {
  const aux = (rule.auxiliaries ?? []).map(escapeLiteral).join('|');
  const irregular = (rule.irregular ?? []).map(escapeLiteral).join('|');
  const re = new RegExp(`(?<!\\p{L})(?:${aux})\\s+(?:(?:not|also|already|then|now|fully|still|being)\\s+)?(\\p{L}{3,}(?:ed|en)${irregular ? `|${irregular}` : ''})(?!\\p{L})`, 'giu');
  const skip = new Set([...(rule.allow ?? []), ...(rule.not_participles ?? [])].map((w) => w.toLowerCase()));
  const hits = [];
  for (const paragraph of ctx.paragraphs) {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      for (const m of sentence.matchAll(re)) {
        if (skip.has(m[1].toLowerCase())) continue;
        if (/(?<!\p{L})by(?!\p{L})/iu.test(sentence.slice(m.index + m[0].length))) continue;
        hits.push({ term: m[0], context: sentence.slice(0, 120) });
      }
    }
  }
  return hits;
}
UNSLOP_DETECTORS.passive = detectPassive;

/** More than `threshold_per_100` adverbs per 100 words, with at least `min_hits`, over the whole prose. */
export function detectAdverbDensity(ctx, rule) {
  const prose = ctx.paragraphs.join(' ');
  const words = prose.split(/\s+/).filter(isWord).length;
  const skip = new Set((rule.not_adverbs ?? []).map((w) => w.toLowerCase()));
  const hits = (prose.match(/(?<!\p{L})\p{L}{2,}ly(?!\p{L})/giu) ?? []).filter((w) => !skip.has(w.toLowerCase()));
  if (words === 0 || hits.length < (rule.min_hits ?? 2) || (hits.length * 100) / words <= (rule.threshold_per_100 ?? 3)) return [];
  return [{ term: `${hits.length} adverbs in ${words} words`, context: hits.join(', '), hits }];
}
UNSLOP_DETECTORS['adverb-density'] = detectAdverbDensity;

const DEFAULT_RULES_PATH = resolve(__dirname, 'templates', 'unslop-rules.yml');

const ID_RE = /^\d{1,2}[a-z]?$/;
const SEVERITIES = ['block', 'warn', 'none'];

/** `all`, or a non-empty array drawn only from `allowed`. */
function checkSet(value, allowed, where, field) {
  if (value === 'all') return;
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => !allowed.includes(v))) {
    throw new Error(`${where}: ${field} must be "all" or a non-empty list drawn from ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
  }
}

/**
 * Load and validate the rule catalogue. The path is module-relative, never the data root.
 * A catalogue that checks nothing, or a rule that cannot say what it enforces, fails loudly:
 * a silent skip would read as a clean text.
 * @returns {{rules: object[], cannotCatch: object[]}}
 */
export function loadUnslopRules(path = DEFAULT_RULES_PATH) {
  const doc = loadYaml(readFileSync(path, 'utf-8')) || {};
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw new Error(`Slop rules file defines no rules: ${path}. An empty rule set checks nothing and would report a clean pass.`);
  }
  const seen = new Set();
  const rules = doc.rules.map((rule, i) => {
    const at = `${path} rule ${i}`;
    if (!rule || typeof rule !== 'object') throw new Error(`${at}: each rule must be a mapping`);
    if (rule.id === undefined || rule.id === null || rule.id === '') throw new Error(`${at}: needs an id`);
    const where = `${at} (${rule.id})`;
    if (typeof rule.id !== 'string' || !ID_RE.test(rule.id)) throw new Error(`${where}: id must be a quoted string such as '13' or '7b'`);
    if (seen.has(rule.id)) throw new Error(`${where}: duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
    if (!String(rule.name ?? '').trim()) throw new Error(`${where}: needs a name`);
    if (!SKILLS.includes(rule.source?.skill)) throw new Error(`${where}: source.skill must be one of ${SKILLS.join(', ')}; got ${JSON.stringify(rule.source?.skill)}`);
    if (!rule.source?.rule) throw new Error(`${where}: source.rule must name the rule or pattern in the source skill`);
    if (!SEVERITIES.includes(rule.severity)) throw new Error(`${where}: severity must be block or warn (or none for a null detector); got ${JSON.stringify(rule.severity)}`);

    if (rule.detect === null) {
      if (!String(rule.unimplemented_because ?? '').trim()) throw new Error(`${where}: a null detector must carry unimplemented_because`);
      if (rule.severity !== 'none') throw new Error(`${where}: severity must be none for a null detector (it is a reading check)`);
    } else {
      if (!Object.hasOwn(UNSLOP_DETECTORS, rule.detect)) {
        throw new Error(`${where}: detect must name a registered detector (${Object.keys(UNSLOP_DETECTORS).join(', ') || 'none registered yet'}), or be null with unimplemented_because; got ${JSON.stringify(rule.detect)}`);
      }
      if (rule.severity === 'none') throw new Error(`${where}: severity must be block or warn for a detector rule`);
    }

    const scope = rule.scope ?? 'prose';
    if (scope !== 'text' && scope !== 'prose') throw new Error(`${where}: scope must be text or prose; got ${JSON.stringify(rule.scope)}`);
    const kinds = rule.kinds ?? 'all';
    const lang = rule.lang ?? 'all';
    checkSet(kinds, KINDS, where, 'kinds');
    checkSet(lang, LANGS, where, 'lang');
    if (!String(rule.must_not_flag ?? '').trim()) {
      throw new Error(`${where}: needs must_not_flag, the half that decides whether the rule is worth having`);
    }
    for (const source of patternSources(rule)) {
      try {
        new RegExp(source, flagsFor(rule));
      } catch (err) {
        throw new Error(`${where}: pattern does not compile: ${source} (${err.message})`);
      }
    }
    return { ...rule, scope, kinds, lang };
  });
  return { rules, cannotCatch: Array.isArray(doc.cannot_catch) ? doc.cannot_catch : [] };
}

let cachedRules = null;
const defaultRules = () => (cachedRules ??= loadUnslopRules().rules);

/**
 * Scan a text against the catalogue.
 * @param {string} text
 * @param {{kind?: string, lang?: 'en'|'fr', rules?: object[]}} [opts]
 * @returns {{findings: object[], skipped: object[], cannotCatch: object[]}} findings sort block first, then catalogue order
 */
export function scanText(text, { kind = 'text', lang, rules } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}; got ${JSON.stringify(kind)}`);
  const whole = String(text ?? '');
  const language = lang ?? detectLang(whole);
  const cannotCatch = loadUnslopRules().cannotCatch;

  if (whole.trim() === '') {
    return {
      findings: [{ id: 'empty-text', name: 'Empty text', severity: 'warn', term: '', context: 'There is no text to check.', source: null }],
      skipped: [],
      cannotCatch,
    };
  }

  const ctx = { text: whole, paragraphs: splitParagraphs(whole).map((sentences) => sentences.join(' ')), kind, lang: language };
  const findings = [];
  const skipped = [];
  for (const rule of rules ?? defaultRules()) {
    if (rule.kinds !== 'all' && !rule.kinds.includes(kind)) continue;
    if (rule.detect === null) {
      skipped.push({ id: rule.id, name: rule.name, reason: rule.unimplemented_because });
      continue;
    }
    if (rule.lang !== 'all' && !rule.lang.includes(language)) {
      skipped.push({ id: rule.id, name: rule.name, reason: `no ${language} list` });
      continue;
    }
    let hits;
    try {
      hits = UNSLOP_DETECTORS[rule.detect](ctx, rule);
    } catch (err) {
      // Fail closed: a text the scanner could not check is never reported clean.
      findings.push({ id: rule.id, name: rule.name, severity: 'block', term: 'detector-error', context: err.message, source: rule.source });
      continue;
    }
    for (const hit of hits) {
      findings.push({ id: rule.id, name: rule.name, severity: rule.severity, term: hit.term, context: hit.context, hint: hit.hint, hits: hit.hits, source: rule.source });
    }
  }
  findings.sort((a, b) => (a.severity === 'block' ? 0 : 1) - (b.severity === 'block' ? 0 : 1));
  return { findings, skipped, cannotCatch };
}

// ---- Fact diff: did a repair keep every number, date, URL, email and name? ----

const EN_NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
// "sept" is left out (it is also a month abbreviation); "un" and "une" are articles, not numbers.
const FR_NUMBER_WORDS = { deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12 };
const NUMBER_WORD_RE = new RegExp(`(?<!\\p{L})(?:${[...Object.keys(EN_NUMBER_WORDS), ...Object.keys(FR_NUMBER_WORDS)].join('|')})(?!\\p{L})`, 'giu');

/** Curly apostrophes straightened and number words written as digits, in both texts before extraction. */
function normalizeForFacts(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(NUMBER_WORD_RE, (w) => String(EN_NUMBER_WORDS[w.toLowerCase()] ?? FR_NUMBER_WORDS[w.toLowerCase()]));
}

const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)';
const NUM_BODY = String.raw`\d(?:[\d']|[.,](?=\d)|\s(?=\d{3}(?!\d)))*`;
const CURRENCY_CODE = { chf: 'CHF', eur: 'EUR', usd: 'USD', gbp: 'GBP', 'fr.': 'CHF', '€': 'EUR', $: 'USD', '£': 'GBP' };

/** A number without thousands separators; a comma that is not a thousands mark becomes a point. */
const cleanNumber = (s) => s.replace(/(?<=\d)[,'    ](?=\d{3}(?!\d))/g, '').replace(/,/g, '.');
const cleanUnit = (s) => s.toLowerCase().replace(/\s+/g, '').replace('µ', 'μ');

/**
 * Fact classes, run in this order; each match is masked with spaces so a later class cannot re-match
 * inside it. `norm` returns the comparable value (and may choose the class: count or number).
 */
const FACT_CLASSES = [
  { res: [new RegExp(String.raw`(?<![\p{L}\p{N}])https?:\/\/[^\s<>()"'\]]*[^\s<>()"'\].,;:!?]`, 'giu')],
    norm: (m) => { const p = /^(https?:\/\/)([^/]+)(.*)$/i.exec(m); return { cls: 'url', value: p ? p[1].toLowerCase() + p[2].toLowerCase() + p[3] : m }; } },
  { res: [new RegExp(String.raw`(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`, 'giu')],
    norm: (m) => ({ cls: 'email', value: m.toLowerCase() }) },
  { res: [new RegExp(String.raw`(?<![\p{L}\p{N}@./-])(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ch|fr|de|io|org|net|dev|eu|li|ai|co|uk|at|it)(?:\/[^\s<>()"',;]*[^\s<>()"',;.!?:])?(?![\p{L}\p{N}])`, 'giu')],
    norm: (m) => ({ cls: 'url', value: m.toLowerCase() }) },
  { res: [
      new RegExp(String.raw`(?:(?:CHF|EUR|USD|GBP|Fr\.)\s?|[€$£])${NUM_BODY}(?:\s?[kKmM])?(?![\p{L}\p{N}])`, 'giu'),
      new RegExp(String.raw`(?<![\p{L}\p{N}.,'])${NUM_BODY}\s?(?:CHF|EUR|USD|GBP|€|\$|£)(?![\p{L}\p{N}])`, 'giu'),
    ],
    norm: (m) => {
      const code = /(CHF|EUR|USD|GBP|Fr\.|€|\$|£)/i.exec(m)[1];
      const body = m.replace(/(CHF|EUR|USD|GBP|Fr\.|€|\$|£)/i, '').trim();
      return { cls: 'currency', value: `${CURRENCY_CODE[code.toLowerCase()] ?? code.toUpperCase()}${cleanNumber(body.replace(/\s?[kKmM]$/, (x) => x.trim().toLowerCase()))}` };
    } },
  { res: [new RegExp(String.raw`\d+(?:[.,]\d+)?\s?%`, 'gu')],
    norm: (m) => ({ cls: 'percent', value: m.replace(/\s/g, '').replace(',', '.') }) },
  { res: [
      new RegExp(String.raw`(?<![\p{L}\p{N}])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}])`, 'gu'),
      new RegExp(String.raw`(?<![\p{L}\p{N}])\d{1,2}(?:st|nd|rd|th|er)?\s+${MONTH}(?!\p{L})(?:\s+\d{4})?(?![\p{L}\p{N}])`, 'giu'),
      new RegExp(String.raw`(?<!\p{L})${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?(?![\p{L}\p{N}])`, 'giu'),
      new RegExp(String.raw`(?<!\p{L})${MONTH}\s+\d{4}(?![\p{L}\p{N}])`, 'giu'),
      new RegExp(String.raw`(?<!\p{N})\d{1,2}[./]\d{1,2}[./]\d{2,4}(?!\p{N})`, 'gu'),
    ],
    norm: (m) => ({ cls: 'date', value: m.toLowerCase().replace(/(?<=\d)(?:st|nd|rd|th|er)(?!\p{L})/gu, '').replace(/,/g, '').replace(/\s+/g, ' ').trim() }) },
  { res: [
      new RegExp(String.raw`(?<![\p{N}:])\d{1,2}(?::|h)\d{2}(?:\s?[ap]\.?m\.?)?(?:\s?(?:CET|CEST|UTC|GMT|BST|EST|PST)(?:[+-]\d{1,2})?)?(?!\p{N})`, 'giu'),
      new RegExp(String.raw`(?<!\p{N})\d{1,2}\s?[ap]\.?m\.?(?!\p{L})`, 'giu'),
    ],
    norm: (m) => ({ cls: 'time', value: m.toLowerCase().replace(/\s+/g, '') }) },
  { res: [
      new RegExp(String.raw`(?<![\p{N}.,])\d+(?:[.,]\d+)?\s?[-–—]\s?\d+(?:[.,]\d+)?(?!\p{N})`, 'gu'),
      new RegExp(String.raw`(?<!\p{N})\d+\s+(?:to|à|bis)\s+\d+(?!\p{N})`, 'giu'),
    ],
    norm: (m) => ({ cls: 'range', value: m.toLowerCase().replace(/\s?[–—]\s?|\s?-\s?|\s+(?:to|à|bis)\s+/g, '-').replace(/,/g, '.') }) },
  { res: [new RegExp(String.raw`(?<![\p{L}\p{N}.,'])\d+(?:(?:[.,']|[    ](?=\d{3}(?!\d)))\d+)*(?:\s?(?:ms|µs|μs|sec|min|hrs?|hours?|days?|weeks?|months?|years?|yrs?|jours?|semaines?|mois|ans?|années?|GB|MB|TB|KB|GiB|MiB|rps|qps|s|h|k|K|M|x|×))?(?![\p{L}\p{N}])`, 'gu')],
    norm: (m) => {
      const unit = /^[\d.,'    ]+?\s?([\p{L}×µ]+)$/u.exec(m)?.[1];
      const digits = unit ? m.slice(0, m.length - unit.length).trim() : m;
      return unit ? { cls: 'count', value: `${cleanNumber(digits)}${cleanUnit(unit)}` } : { cls: 'number', value: cleanNumber(digits) };
    } },
];

const STOP_CAPS = new Set(['I', 'A', 'An', 'The', 'My', 'Your', 'Our', 'Their', 'His', 'Her', 'Its', 'We', 'You', 'They', 'He', 'She', 'It', 'This', 'That', 'These', 'Those', 'Since', 'In', 'On', 'At', 'For', 'From', 'With', 'As', 'If', 'When', 'While', 'After', 'Before', 'Also', 'And', 'But', 'So', 'Or', 'Dear', 'Kind', 'Best', 'Regards', 'Hello', 'Hi', 'Please', 'Thank', 'Thanks', 'Could', 'Would', 'Can', 'Will', 'Should', 'Which', 'What', 'Who', 'Where', 'How', 'Why', 'There', 'Here', 'Each', 'Every', 'All', 'Both', 'Yes', 'No', 'Not', 'Je', 'J', 'Le', 'La', 'Les', 'L', 'Un', 'Une', 'Des', 'De', 'Du', 'Mon', 'Ma', 'Mes', 'Votre', 'Vos', 'Notre', 'Nos', 'Nous', 'Vous', 'Il', 'Elle', 'Ils', 'Elles', 'Ce', 'Cette', 'Ces', 'Depuis', 'Dans', 'En', 'Pour', 'Avec', 'Sur', 'Par', 'Et', 'Mais', 'Ou', 'Donc', 'Madame', 'Monsieur', 'Bonjour', 'Cordialement', 'Veuillez', 'Merci']);
const NAME_RE = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}\p{N}+#.'-]*[\p{L}\p{N}+#]|\p{Lu}|\p{Ll}+\p{Lu}[\p{L}\p{N}]*|\p{L}+\p{N}[\p{L}\p{N}]*)(?![\p{L}\p{N}])/gu;
const INTERNAL = /\p{Ll}\p{Lu}|\p{L}\p{N}/u;
const SENTENCE_START = /(?:^[ \t]*|\n[ \t]*|[.!?:]\s+)$/;

/** Facts per class from a text, plus the text with every fact blanked out (for name counting). */
function extractFacts(text) {
  let masked = normalizeForFacts(text);
  const facts = [];
  for (const spec of FACT_CLASSES) {
    for (const re of spec.res) {
      masked = masked.replace(re, (m) => {
        facts.push(spec.norm(m));
        return ' '.repeat(m.length);
      });
    }
  }
  return { facts, masked };
}

/** Distinct names in a masked text: capitalised words inside a sentence, plus camelCase and letter+digit words. */
function namesOf(masked) {
  const names = new Set();
  for (const m of masked.matchAll(NAME_RE)) {
    if (INTERNAL.test(m[0])) { names.add(m[0]); continue; }
    if (STOP_CAPS.has(m[0]) || SENTENCE_START.test(masked.slice(0, m.index))) continue;
    names.add(m[0]);
  }
  return names;
}

const countWord = (masked, word) => [...masked.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu'))].length;

/**
 * Compare the facts of a text before and after a repair. A fact present only in `after` is not a finding.
 * @returns {{ok: boolean, kept: number, missing: {cls: string, value: string}[], altered: {cls: string, from: string, to: string}[]}}
 */
export function diffFacts(before, after) {
  const b = extractFacts(before);
  const a = extractFacts(after);
  const byClass = (facts) => facts.reduce((acc, f) => { (acc[f.cls] ??= []).push(f.value); return acc; }, {});
  const beforeBy = byClass(b.facts);
  const afterBy = byClass(a.facts);
  const missing = [];
  const altered = [];
  let kept = 0;

  for (const [cls, values] of Object.entries(beforeBy)) {
    const rest = [...(afterBy[cls] ?? [])];
    const left = [];
    for (const v of values) {
      const i = rest.indexOf(v);
      if (i >= 0) { rest.splice(i, 1); kept += 1; } else left.push(v);
    }
    left.forEach((v, i) => (i < rest.length ? altered.push({ cls, from: v, to: rest[i] }) : missing.push({ cls, value: v })));
  }

  for (const name of namesOf(b.masked)) {
    const was = countWord(b.masked, name);
    const now = countWord(a.masked, name);
    if (now < was) missing.push({ cls: 'name', value: name });
    else kept += 1;
  }
  return { ok: missing.length === 0 && altered.length === 0, kept, missing, altered };
}

const USAGE = `Usage: node unslop.mjs <file> [--kind letter|email|message|answer|cv|text] [--lang en|fr]
       node unslop.mjs --diff <before> <after>

The Outbound text gate scanner. Checks a text against templates/unslop-rules.yml
(AI-writing patterns) and prints each finding. --diff reports any number, date,
URL, email or name that a repair lost or altered.

Options:
  --kind <kind>   letter, email, message, answer, cv or text (default text)
  --lang <en|fr>  Language lists; detected from the text when absent
  --diff          Compare two files: <before> <after>
  --help, -h      This message

Exit codes: 0 no block finding; 2 a block finding or a failed --diff;
1 a usage error or unreadable input.
`;

const KNOWN_FLAGS = ['--kind', '--lang', '--diff', '--help', '-h'];
const VALUE_FLAGS = ['--kind', '--lang'];

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

  if (args.includes('--diff')) {
    if (args.includes('--kind') || args.includes('--lang')) fail('--diff takes no --kind or --lang');
    if (positionals.length !== 2) fail('--diff takes two files: node unslop.mjs --diff <before> <after>');
    for (const path of positionals) if (!existsSync(path)) fail(`file not found: ${path}`);
    let before;
    let after;
    try {
      before = readFileSync(positionals[0], 'utf-8');
      after = readFileSync(positionals[1], 'utf-8');
    } catch (e) {
      fail(`cannot read the files: ${e.message}`);
    }
    const result = diffFacts(before, after);
    if (result.ok) {
      console.log(`Fact check passed: ${result.kept} facts kept.`);
      return;
    }
    console.log(`Fact check failed: ${result.missing.length} missing, ${result.altered.length} altered`);
    for (const f of result.missing) console.log(`  ✖ missing ${f.cls}: ${f.value}`);
    for (const f of result.altered) console.log(`  ✖ altered ${f.cls}: ${f.from} → ${f.to}`);
    process.exitCode = 2;
    return;
  }

  const [input] = positionals;
  if (!input) fail('give the text file: node unslop.mjs <file> [--kind letter|email|message|answer|cv|text] [--lang en|fr]');
  if (!existsSync(input)) fail(`file not found: ${input}`);

  const kind = flagValue(args, '--kind') ?? 'text';
  if (!KINDS.includes(kind)) fail(`--kind must be one of ${KINDS.join(', ')}`);
  const lang = flagValue(args, '--lang');
  if (lang !== undefined && !LANGS.includes(lang)) fail('--lang must be en or fr');

  let text;
  try {
    text = readFileSync(input, 'utf-8');
  } catch (e) {
    fail(`cannot read ${input}: ${e.message}`);
  }

  const language = lang ?? detectLang(text);
  const { findings, skipped } = scanText(text, { kind, lang: language });
  const blocks = findings.filter((f) => f.severity === 'block').length;

  if (findings.length === 0) {
    console.log(`Slop check passed (kind ${kind}, lang ${language}): no findings.`);
  } else {
    console.log(`Slop check (kind ${kind}, lang ${language}): ${findings.length} finding${findings.length === 1 ? '' : 's'}, ${blocks} block`);
    for (const f of findings) {
      const mark = f.severity === 'block' ? '✖' : '⚠';
      console.log(`  ${mark} ${f.id} ${f.name}: "${f.term}"${f.hint ? ` → ${f.hint}` : ''}`);
    }
  }
  const reading = skipped.filter((s) => !s.reason.startsWith('no '));
  const noList = skipped.filter((s) => s.reason.startsWith('no '));
  if (reading.length) console.log(`Not scanned (reading check): ${reading.map((s) => s.id).join(', ')}`);
  if (noList.length) console.log(`Not scanned for ${language}: ${noList.map((s) => s.id).join(', ')}`);
  if (blocks > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) runCli(process.argv.slice(2));
