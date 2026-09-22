#!/usr/bin/env node

/**
 * validate-portals.mjs — schema/shape validator for portals.yml.
 *
 * Usage:
 *   node validate-portals.mjs
 *   node validate-portals.mjs --file templates/portals.example.yml
 *   node validate-portals.mjs --self-test
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(ROOT, 'providers');
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

function add(list, path, message) {
  list.push({ path, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateUrl(value, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    add(errors, path, 'must be a string URL');
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    add(errors, path, `invalid URL: ${value}`);
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    add(errors, path, `unsupported URL protocol: ${parsed.protocol}`);
  }
}

function validateKeywordList(value, path, errors) {
  if (value === undefined || value === null) return;
  const arr = Array.isArray(value) ? value : [value];
  for (const [idx, item] of arr.entries()) {
    if (typeof item !== 'string') {
      add(errors, `${path}[${idx}]`, 'keyword must be a string');
      continue;
    }
    if (item.trim() === '') {
      add(errors, `${path}[${idx}]`, 'keyword must not be empty');
    }
  }
}

function validateParser(parser, path, errors) {
  if (parser === undefined || parser === null) return;
  if (!isObject(parser)) {
    add(errors, path, 'parser must be an object');
    return;
  }
  if (typeof parser.command !== 'string' || parser.command.trim() === '') {
    add(errors, `${path}.command`, 'parser.command must be a non-empty string');
  }
  if (parser.script !== undefined && (typeof parser.script !== 'string' || parser.script.trim() === '')) {
    add(errors, `${path}.script`, 'parser.script must be a non-empty string when set');
  }
  if (parser.args !== undefined && !Array.isArray(parser.args)) {
    add(errors, `${path}.args`, 'parser.args must be an array when set');
  }
  if (parser.timeout_ms !== undefined && (!Number.isFinite(Number(parser.timeout_ms)) || Number(parser.timeout_ms) <= 0)) {
    add(errors, `${path}.timeout_ms`, 'parser.timeout_ms must be a positive number when set');
  }
  if (parser.max_buffer_bytes !== undefined && (!Number.isFinite(Number(parser.max_buffer_bytes)) || Number(parser.max_buffer_bytes) <= 0)) {
    add(errors, `${path}.max_buffer_bytes`, 'parser.max_buffer_bytes must be a positive number when set');
  }
}

async function loadProviderIds() {
  const ids = new Set();
  if (existsSync(PROVIDERS_DIR)) {
    const files = readdirSync(PROVIDERS_DIR)
      .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
      .sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(join(PROVIDERS_DIR, file)).href);
      if (mod.default?.id) ids.add(mod.default.id);
    }
  }

  // scan.mjs accepts explicit provider-plugin ids even when a plugin is
  // disabled or missing credentials (the runtime installs an actionable
  // inactive-provider stub). Keep validation aligned with that contract.
  try {
    const { discoverPlugins, pluginRoots, resolveSuccessorIds } = await import('./plugins/_engine.mjs');
    const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
    for (const manifest of manifests) {
      if (manifest.hooks.includes('provider')) ids.add(manifest.id);
    }
  } catch (err) {
    // A stripped-down checkout may not include plugin infrastructure. Core
    // provider validation should continue to work in that environment.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return ids;
}

const TITLE_FILTER_FIELDS = ['positive', 'negative', 'seniority_boost'];
const TRACK_FIELDS = ['scope', 'tag', 'title_filter', 'location_filter', 'salary_filter', 'content_filter', 'search_queries', 'job_boards'];

/**
 * Validates the title_filter/location_filter/content_filter/salary_filter
 * quartet shared by the flat top-level config and each tracks.<id> block
 * (#track-unification, 2026-09-21) — one shape, checked at whatever path
 * prefix the caller is validating.
 *
 * @param {object} block - The object carrying these keys (top-level config, or a tracks.<id> block).
 * @param {string} prefix - '' for the flat top-level, `tracks.${id}` for a track.
 * @param {Array} errors
 * @param {Array} warnings
 */
function validateFilterQuartet(block, prefix, errors, warnings) {
  const path = (suffix) => (prefix ? `${prefix}.${suffix}` : suffix);

  if (block.title_filter !== undefined) {
    if (!isObject(block.title_filter)) {
      add(errors, path('title_filter'), 'title_filter must be an object');
    } else {
      validateKeywordList(block.title_filter.positive, path('title_filter.positive'), errors);
      validateKeywordList(block.title_filter.negative, path('title_filter.negative'), errors);
      validateKeywordList(block.title_filter.seniority_boost, path('title_filter.seniority_boost'), errors);
    }
  }

  if (block.location_filter !== undefined) {
    if (!isObject(block.location_filter)) {
      add(errors, path('location_filter'), 'location_filter must be an object');
    } else {
      validateKeywordList(block.location_filter.always_allow, path('location_filter.always_allow'), errors);
      validateKeywordList(block.location_filter.allow, path('location_filter.allow'), errors);
      validateKeywordList(block.location_filter.block, path('location_filter.block'), errors);
      validateKeywordList(block.location_filter.block_hard, path('location_filter.block_hard'), errors);
      if (block.location_filter.strict !== undefined && typeof block.location_filter.strict !== 'boolean') {
        add(errors, path('location_filter.strict'), 'must be a boolean when set');
      }
    }
  }

  if (block.salary_filter !== undefined) {
    if (!isObject(block.salary_filter)) {
      add(errors, path('salary_filter'), 'salary_filter must be an object');
    } else {
      if (block.salary_filter.min !== undefined && !Number.isFinite(Number(block.salary_filter.min))) {
        add(errors, path('salary_filter.min'), 'must be a number when set');
      }
      if (block.salary_filter.max !== undefined && !Number.isFinite(Number(block.salary_filter.max))) {
        add(errors, path('salary_filter.max'), 'must be a number when set');
      }
      if (block.salary_filter.currency !== undefined && (typeof block.salary_filter.currency !== 'string' || !block.salary_filter.currency.trim())) {
        add(errors, path('salary_filter.currency'), 'must be a non-empty string when set');
      }
    }
  }

  if (block.content_filter !== undefined) {
    if (!isObject(block.content_filter)) {
      add(errors, path('content_filter'), 'content_filter must be an object');
    } else {
      validateKeywordList(block.content_filter.positive, path('content_filter.positive'), errors);
      validateKeywordList(block.content_filter.negative, path('content_filter.negative'), errors);
      if (block.content_filter.by_title_keyword !== undefined) {
        if (!isObject(block.content_filter.by_title_keyword)) {
          add(errors, path('content_filter.by_title_keyword'), 'by_title_keyword must be an object keyed by title_filter.positive keyword');
        } else {
          // Cross-references THIS block's own title_filter.positive, not the
          // flat one — a track's content_filter override is scoped to its
          // own lane's title keywords.
          const titlePositive = new Set(
            (Array.isArray(block.title_filter?.positive) ? block.title_filter.positive : [])
              .filter(k => typeof k === 'string')
              .map(k => k.trim().toLowerCase())
          );
          for (const [kw, rule] of Object.entries(block.content_filter.by_title_keyword)) {
            const p = path(`content_filter.by_title_keyword.${kw}`);
            if (!titlePositive.has(kw.trim().toLowerCase())) {
              add(warnings, p, `"${kw}" does not match any title_filter.positive keyword and will never apply`);
            }
            if (!isObject(rule)) {
              add(errors, p, 'must be an object with positive/negative keyword lists');
              continue;
            }
            validateKeywordList(rule.positive, `${p}.positive`, errors);
            validateKeywordList(rule.negative, `${p}.negative`, errors);
          }
        }
      }
    }
  }
}

export async function validatePortalsConfig(config, { providerIds = new Set() } = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(config)) {
    add(errors, '<root>', 'portals config must be a YAML object');
    return { errors, warnings };
  }

  validateFilterQuartet(config, '', errors, warnings);

  // #track-unification (2026-09-21): the open-ended tracks map. Absent
  // entirely is valid (the legacy flat-only schema — templates/portals.example.yml
  // and any fork that never migrated); present but empty, or malformed, is a
  // real misconfiguration and an error — never a silent skip that would read
  // as "0 warnings, all fine" (mirrors scan.mjs's parseTracks fallback rule).
  const declaredTags = [];
  if (config.tracks !== undefined) {
    if (!isObject(config.tracks) || Object.keys(config.tracks).length === 0) {
      add(errors, 'tracks', 'tracks must be a non-empty object when set');
    } else {
      for (const [id, def] of Object.entries(config.tracks)) {
        const prefix = `tracks.${id}`;
        if (!isObject(def)) {
          add(errors, prefix, 'track must be an object');
          continue;
        }
        for (const key of Object.keys(def)) {
          if (!TRACK_FIELDS.includes(key)) {
            add(errors, `${prefix}.${key}`, `unknown track field - expected one of ${TRACK_FIELDS.join(', ')}`);
          }
        }
        if (def.scope !== 'all' && def.scope !== 'tagged') {
          add(errors, `${prefix}.scope`, 'scope must be "all" or "tagged"');
        } else if (def.scope === 'tagged') {
          if (typeof def.tag !== 'string' || !def.tag.trim()) {
            add(errors, `${prefix}.tag`, 'a scope: tagged track must have a non-empty string tag');
          } else {
            declaredTags.push(def.tag);
          }
        }
        validateFilterQuartet(def, prefix, errors, warnings);
        if (def.search_queries !== undefined && !Array.isArray(def.search_queries)) {
          add(errors, `${prefix}.search_queries`, 'search_queries must be an array when set');
        }
        if (def.job_boards !== undefined && !Array.isArray(def.job_boards)) {
          add(errors, `${prefix}.job_boards`, 'job_boards must be an array when set');
        }
      }
    }
  }

  // Optional per-scanner override consumed only by scan-ats-full.mjs. Same
  // shape as title_filter, so it gets the same structural checks — an
  // unvalidated key would let a typo ("positve") silently resolve to a
  // profile with no positive keywords, which matches every posting.
  if (config.title_filter_full !== undefined) {
    if (!isObject(config.title_filter_full)) {
      add(errors, 'title_filter_full', 'title_filter_full must be an object');
    } else {
      // A misspelled field is the dangerous case, not a missing one:
      // `positve:` leaves `positive` undefined, buildTitleFilter treats an
      // empty positive list as "no positive constraint", and the sweep then
      // matches every title on every board — the exact outcome this key
      // exists to prevent. An unknown field is therefore an error, while
      // `positive: []` stays valid as a deliberate choice.
      for (const key of Object.keys(config.title_filter_full)) {
        if (!TITLE_FILTER_FIELDS.includes(key)) {
          add(errors, `title_filter_full.${key}`, `unknown title_filter_full field - expected one of ${TITLE_FILTER_FIELDS.join(', ')}`);
        }
      }
      validateKeywordList(config.title_filter_full.positive, 'title_filter_full.positive', errors);
      validateKeywordList(config.title_filter_full.negative, 'title_filter_full.negative', errors);
      validateKeywordList(config.title_filter_full.seniority_boost, 'title_filter_full.seniority_boost', errors);
    }
  }

  if (config.visa_filter !== undefined) {
    if (!isObject(config.visa_filter)) {
      add(errors, 'visa_filter', 'visa_filter must be an object');
    } else {
      if (config.visa_filter.enabled !== undefined && typeof config.visa_filter.enabled !== 'boolean') {
        add(errors, 'visa_filter.enabled', 'must be a boolean when set');
      }
      if (config.visa_filter.require_mention !== undefined && typeof config.visa_filter.require_mention !== 'boolean') {
        add(errors, 'visa_filter.require_mention', 'must be a boolean when set');
      }
      validateKeywordList(config.visa_filter.positive, 'visa_filter.positive', errors);
      validateKeywordList(config.visa_filter.negative, 'visa_filter.negative', errors);
    }
  }

  if (config.search_queries !== undefined && !Array.isArray(config.search_queries)) {
    add(errors, 'search_queries', 'search_queries must be an array when set');
  }

  // tracked_companies and job_boards share one entry schema (name / careers_url /
  // api / provider / parser) and one dedup namespace downstream, so validate them
  // in a single pass. seenEnabledNames spans both lists: a board and a company
  // that share a name would still collide in the scanner's reporting.
  const seenEnabledNames = new Map();
  const validateEntryList = (list, key, noun) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      add(errors, key, `${key} must be an array when set`);
      return;
    }
    for (const [idx, entry] of list.entries()) {
      const base = `${key}[${idx}]`;
      if (!isObject(entry)) {
        add(errors, base, `${noun} entry must be an object`);
        continue;
      }
      if (entry.enabled === false) continue;

      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        add(errors, `${base}.name`, `enabled ${noun} must have a non-empty string name`);
      } else {
        const normalized = normalizeName(entry.name);
        if (seenEnabledNames.has(normalized)) {
          add(warnings, `${base}.name`, `duplicate enabled ${noun} name also seen at ${seenEnabledNames.get(normalized)}`);
        } else {
          seenEnabledNames.set(normalized, `${base}.name`);
        }
      }

      validateUrl(entry.careers_url, `${base}.careers_url`, errors);
      validateUrl(entry.api, `${base}.api`, errors);

      if (entry.provider !== undefined) {
        if (typeof entry.provider !== 'string' || entry.provider.trim() === '') {
          add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
        } else if (!providerIds.has(entry.provider)) {
          add(errors, `${base}.provider`, `unknown provider "${entry.provider}"`);
        }
      }

      validateParser(entry.parser, `${base}.parser`, errors);
    }
  };

  validateEntryList(config.tracked_companies, 'tracked_companies', 'company');
  validateEntryList(config.job_boards, 'job_boards', 'job board');

  // Orphan tag-field warning (#track-unification, 2026-09-21): a company
  // field that LOOKS like a track-eligibility tag (matches /^track.*_/, the
  // trackb_whitelisted naming convention) but that no declared track claims
  // as its own `tag` is almost certainly a typo (trackb_whitelist vs
  // trackb_whitelisted) that would silently empty a scope: tagged lane —
  // the company thinks it's tagged in, the track never sees it.
  if (Array.isArray(config.tracked_companies)) {
    const declaredTagSet = new Set(declaredTags);
    const warnedFields = new Set();
    for (const [idx, entry] of config.tracked_companies.entries()) {
      if (!isObject(entry)) continue;
      for (const field of Object.keys(entry)) {
        if (!/^track.*_/i.test(field)) continue;
        if (declaredTagSet.has(field)) continue;
        if (warnedFields.has(field)) continue;
        warnedFields.add(field);
        add(warnings, `tracked_companies[${idx}].${field}`, `"${field}" looks like a track-eligibility tag but no track declares it as its tag — check for a typo`);
      }
    }
  }

  return { errors, warnings };
}

function formatIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

async function validateFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const providerIds = await loadProviderIds();
  const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
  return validatePortalsConfig(parsed, { providerIds });
}

async function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-validate-portals-self-test-'));
  try {
    const file = join(tmp, 'bad.yml');
    writeFileSync(file, `
title_filter:
  positive: ["AI", ""]
tracked_companies:
  - name: "Acme"
    provider: "not-real"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');
    const result = await validateFile(file);
    if (result.errors.length !== 2) {
      throw new Error(`expected 2 errors, got ${result.errors.length}`);
    }
    console.log('validate-portals self-test OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  // An explicit but empty `--file=` must reach the usage error below. Passing
  // '' to resolve() would return the CURRENT DIRECTORY, and the script would
  // then try to validate a directory and report a filesystem error instead.
  const fileFlag = hasFlag(args, '--file') ? (flagValue(args, '--file') ?? '') : undefined;
  const filePath = fileFlag === undefined ? resolve(DEFAULT_PORTALS_PATH) : (fileFlag ? resolve(fileFlag) : '');
  if (!filePath) {
    console.error('Usage: node validate-portals.mjs [--file portals.yml] [--self-test]');
    process.exit(1);
  }

  let result;
  try {
    result = await validateFile(filePath);
  } catch (err) {
    console.error(`validate-portals failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`validate-portals: ${filePath}`);
  for (const warning of result.warnings) console.log(`warning: ${formatIssue(warning)}`);
  for (const error of result.errors) console.log(`error: ${formatIssue(error)}`);
  console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`validate-portals failed: ${err.message}`);
  process.exit(1);
});
