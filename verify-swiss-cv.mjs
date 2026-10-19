#!/usr/bin/env node
/**
 * verify-swiss-cv.mjs — warn-only check of a CV payload against the jobup.ch
 * Swiss CV checklist (read 2026-10-19). Zero network, zero model.
 *
 *   node verify-swiss-cv.mjs <payload.json> [--pdf <file>]
 *
 * It reports findings and exits 0, whether or not it found any: the fact gate
 * (verify-cv-facts.mjs) stays the only hard gate. Exit 1 means a usage error or
 * unreadable input. Checked: no "Curriculum Vitae" title, a home address,
 * nationality and work permit in the header, a photo, a profile of at most 5
 * sentences without vague adjectives, a Languages rubric where every entry has
 * a CEFR level or "native", and with --pdf a file of at most 5 MB.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY_SENTENCES = 5;

// Adjectives jobup tells candidates to replace with concrete examples, plus the
// usual cousins in English, French and German. Matched as whole words, case-insensitively.
const VAGUE_WORDS = [
  'motivated', 'hard-working', 'hardworking', 'hard worker', 'dynamic', 'passionate', 'determined', 'enthusiastic', 'team player',
  'motivé', 'motivée', 'travailleur acharné', 'dynamique', 'passionné', 'passionnée', 'rigoureux', 'rigoureuse',
  'motiviert', 'engagiert', 'teamfähig', 'leidenschaftlich', 'zielstrebig',
];
const VAGUE_RE = new RegExp(`(?<![\\p{L}-])(${VAGUE_WORDS.map((w) => w.replace(/[-\s]/g, (c) => (c === '-' ? '-' : '\\s+'))).join('|')})(?![\\p{L}-])`, 'giu');

const CEFR_RE = /\b[ABC][12]\b/i;
const NATIVE_RE = /\b(native|mother\s+tongue)\b|langue\s+maternelle|muttersprache/i;

const USAGE = `Usage: node verify-swiss-cv.mjs <payload.json> [--pdf <file>]

Warn-only check of a CV payload against the jobup.ch Swiss CV checklist. Prints
each finding and exits 0; exits 1 only on a usage error or unreadable input.

Options:
  --pdf <file>   Also check that the PDF is at most 5 MB
  --help         This message
`;

const KNOWN_FLAGS = ['--pdf', '--help', '-h'];
const VALUE_FLAGS = ['--pdf'];

const present = (v) => v != null && typeof v !== 'object' && String(v).trim() !== '';

function sentenceCount(text) {
  const plain = String(text ?? '').replace(/\*\*/g, '').trim();
  if (!plain) return 0;
  return plain.split(/(?<=[.!?])\s+(?=[A-Z0-9À-ÖØ-Þ])/).filter((s) => s.trim()).length;
}

/**
 * @param {object} payload a CV payload as build-cv-html.mjs reads it
 * @param {{pdfSize?: number}} [opts]
 * @returns {{code: string, message: string}[]}
 */
export function checkSwissCv(payload, { pdfSize } = {}) {
  const findings = [];
  const add = (code, message) => findings.push({ code, message });
  const candidate = payload?.candidate ?? {};

  if (/curriculum\s+vitae/i.test(`${candidate.name ?? ''} ${candidate.title ?? ''}`)) {
    add('curriculum-vitae', 'The heading says "Curriculum Vitae": use your name and a title that fits the role.');
  }
  if (!present(candidate.address)) add('missing-address', 'No home address in the header; jobup lists it as required.');
  if (!present(candidate.nationality)) add('missing-nationality', 'No nationality line in the header.');
  if (!present(candidate.work_permit)) add('missing-work-permit', 'No work permit or work authorisation line in the header.');
  if (!present(candidate.photo)) add('missing-photo', 'No photo; common in Switzerland, especially Romandie, though not mandatory.');

  const summary = String(payload?.summary ?? '');
  const sentences = sentenceCount(summary);
  if (sentences > MAX_SUMMARY_SENTENCES) {
    add('summary-too-long', `The profile has ${sentences} sentences; jobup says at most ${MAX_SUMMARY_SENTENCES}.`);
  }
  const vague = [...new Set([...summary.matchAll(VAGUE_RE)].map((m) => m[1].toLowerCase()))];
  if (vague.length) {
    add('vague-adjective', `Vague wording in the profile (${vague.join(', ')}); give a concrete example instead.`);
  }

  const languages = (Array.isArray(payload?.languages) ? payload.languages : []).filter((e) => present(e?.language));
  if (languages.length === 0) {
    add('missing-languages', 'No Languages section; list each language with its CEFR level.');
  } else {
    const unleveled = languages
      .filter((e) => !(CEFR_RE.test(String(e.level ?? '')) || NATIVE_RE.test(String(e.level ?? ''))))
      .map((e) => String(e.language).trim());
    if (unleveled.length) add('language-level', `No CEFR level (A1 to C2) or "native" for: ${unleveled.join(', ')}.`);
  }

  if (pdfSize != null && pdfSize > MAX_PDF_BYTES) {
    add('pdf-too-large', `The PDF is ${(pdfSize / 1024 / 1024).toFixed(1)} MB; jobup says at most 5 MB.`);
  }
  return findings;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function runCli(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const pdfPath = flagValue(args, '--pdf');
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) positionals.push(args[i]);
  }
  const [payloadPath] = positionals;
  if (!payloadPath) fail('give the payload file: node verify-swiss-cv.mjs <payload.json> [--pdf <file>]');
  if (!existsSync(payloadPath)) fail(`payload file not found: ${payloadPath}`);

  let payload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf-8'));
  } catch (e) {
    fail(`${payloadPath} is not valid JSON: ${e.message}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) fail(`${payloadPath} must hold a JSON object`);

  let pdfSize;
  if (pdfPath !== undefined) {
    if (!existsSync(pdfPath)) fail(`PDF not found: ${pdfPath}`);
    pdfSize = statSync(pdfPath).size;
  }

  const findings = checkSwissCv(payload, { pdfSize });
  if (findings.length === 0) {
    console.log('Swiss CV check passed: no findings.');
    return;
  }
  console.log(`Swiss CV check: ${findings.length} finding${findings.length === 1 ? '' : 's'} (warn-only)`);
  for (const f of findings) console.log(`  ⚠ ${f.code}: ${f.message}`);
}

if (isMainModule(import.meta.url)) {
  runCli(process.argv.slice(2));
}
