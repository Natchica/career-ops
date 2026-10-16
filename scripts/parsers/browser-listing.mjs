#!/usr/bin/env node
// Browser-rendered listing parser (jobs-json-v1).
//
// Thin wrapper over browser-extract.mjs --mode listing for career pages that
// build their posting list client-side and expose no JSON endpoint, so
// html-listing.mjs has nothing to read. browser-extract returns every anchor on
// the rendered page — nav, language switchers, consent vendors included — so a
// --link-pattern is required to keep only postings.
//
// Usage:
//   node scripts/parsers/browser-listing.mjs --url URL --link-pattern REGEX
//        [--exclude REGEX] [--location TEXT] [--timeout MS]

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPipelineLock } from '../../pipeline-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = path.resolve(HERE, '../../browser-extract.mjs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const linkPattern = arg('link-pattern');
if (!url || !linkPattern) {
  process.stderr.write('usage: --url URL --link-pattern REGEX [--exclude REGEX] [--location TEXT] [--timeout MS]\n');
  process.exit(2);
}
const include = new RegExp(linkPattern, 'i');
const exclude = arg('exclude') ? new RegExp(arg('exclude'), 'i') : null;
const location = arg('location', '');

// scan.mjs runs parsers concurrently and each run launches its own Chromium, so
// serialize them across processes. The wait ceiling is 60 s per browser-listing
// board configured in portals.yml (6 boards -> 360 s); parser.timeout_ms there
// must exceed it by one extract run.
const LOCK_WAIT_MS = 360_000;
const startedWaiting = Date.now();
const raw = await withPipelineLock(
  path.join(tmpdir(), 'career-ops-browser-listing'),
  () => {
    process.stderr.write(`browser-listing: lock acquired after ${Date.now() - startedWaiting} ms\n`);
    return execFileSync(
      process.execPath,
      [EXTRACTOR, url, '--mode', 'listing', '--timeout', arg('timeout', '30000')],
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
    );
  },
  { timeoutMs: LOCK_WAIT_MS, maxWaitMs: LOCK_WAIT_MS },
);

const payload = JSON.parse(raw);
if (payload.error) throw new Error(`${payload.code || 'extract-failed'}: ${payload.error}`);

const seen = new Set();
const jobs = [];
for (const j of payload.jobs ?? []) {
  if (!j?.url || !j?.title) continue;
  if (!include.test(j.url)) continue;
  if (exclude && exclude.test(j.url)) continue;
  if (seen.has(j.url)) continue;
  seen.add(j.url);
  jobs.push({ title: j.title.trim(), url: j.url, location });
}

process.stdout.write(JSON.stringify(jobs));
