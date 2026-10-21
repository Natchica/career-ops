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
import * as yaml from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { detectLang, splitParagraphs, termRe } from './lib/letter-text.mjs';

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

/** Terms (whole-word, apostrophe-tolerant) and patterns for the text's language, over the rule's scope. */
export function detectMatchList(ctx, rule) {
  const terms = [...(rule.terms?.all ?? []), ...(rule.terms?.[ctx.lang] ?? [])];
  const sources = [...(rule.patterns?.all ?? []), ...(rule.patterns?.[ctx.lang] ?? [])];
  const regexes = [...(terms.length ? [termRe(terms)] : []), ...sources.map((source) => new RegExp(source, flagsFor(rule)))];
  const subjects = rule.scope === 'text' ? [ctx.text] : ctx.paragraphs;
  const hits = [];
  for (const subject of subjects) {
    for (const re of regexes) {
      for (const m of subject.matchAll(re)) {
        if (m[0] === '') continue;
        hits.push({ term: m[0], context: contextAround(subject, m.index, m[0].length) });
      }
    }
  }
  return hits;
}
UNSLOP_DETECTORS['match-list'] = detectMatchList;

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
  const doc = yaml.load(readFileSync(path, 'utf-8')) || {};
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

  if (args.includes('--diff')) fail('--diff is not available yet');

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
