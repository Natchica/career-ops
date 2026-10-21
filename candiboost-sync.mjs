#!/usr/bin/env node
/**
 * candiboost-sync.mjs — read Candiboost sends back from Gmail Sent.
 *
 *   node --env-file=.env candiboost-sync.mjs sync [--dry-run] [--summary] [--threads-file <json>]
 *   node candiboost-sync.mjs pick [--count N] [--domain <d>] [--summary]
 *   node candiboost-sync.mjs mark <thread_id> followed [--date YYYY-MM-DD]
 *
 * `sync` reads the candidate's own Sent folder (gmail.readonly), records every
 * Candiboost send in data/candiboost.tsv, the tracker and the phonebook, and
 * hands replies to reply-watch. Zero model calls. Mail bodies, bounces and
 * replies are untrusted data. See modes/candiboost.md.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { unescapeFormulaCell } from './lib/tsv-formula-escape.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { CLI_EXIT } from './tracker-utils.mjs';
import { readRegistry, registryPath } from './radar/registry.mjs';
import {
  REGISTRY_COLUMNS, buildProspectIndex, parseThread, planSync, readTable,
} from './lib/candiboost.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const QUERY = 'in:sent subject:"Candidature spontanée"';
const GMAIL_ENV = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
const FETCH_BATCH = 8;
const REGISTRY_SPEC = { key: 'thread_id', columns: REGISTRY_COLUMNS };

const USAGE = `Usage: node --env-file=.env candiboost-sync.mjs <sync|pick|mark> [options]

  sync [--dry-run] [--summary] [--threads-file <json>]
      Read the Candiboost sends from Gmail Sent (read-only) and record them in
      data/candiboost.tsv, the tracker, data/contacts.tsv and
      data/reply-candidates.json. --dry-run writes nothing.
  pick [--count N] [--domain <d>] [--summary]
      The next sends due their personalised follow-up (1-2). Read-only.
  mark <thread_id> followed [--date YYYY-MM-DD]
      Record that the follow-up was sent. Changes the registry only.

Options:
  --dry-run            Report what sync would do, write nothing
  --summary            Human-readable output instead of JSON
  --json               JSON output (the default)
  --threads-file <f>   Read saved threads.get objects instead of calling Gmail
  --count <n>          Picks to show (1-2, default 2)
  --domain <d>         Show the rows of one recipient domain, with a reason for each
  --date <d>           Date of the follow-up for \`mark\` (default today)
  --help               This message

Gmail credentials come from GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and
GMAIL_REFRESH_TOKEN: run with \`node --env-file=.env\`.
`;

const KNOWN_FLAGS = ['--dry-run', '--summary', '--json', '--threads-file', '--count', '--domain', '--date', '--help', '-h'];
const VALUE_FLAGS = ['--threads-file', '--count', '--domain', '--date'];

export class GmailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GmailError';
  }
}

function fail(message, code = CLI_EXIT.USAGE) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

async function googleJson(fetchFn, url, init, what) {
  const res = await fetchFn(url, init);
  let body = {};
  try { body = await res.json(); } catch { /* an unreadable body is reported by status below */ }
  const err = body?.error;
  if (res.ok && !err) return body;
  let detail;
  if (err && typeof err === 'object') detail = [err.status ?? err.code, err.message].filter(Boolean).join(': ');
  else if (err) detail = [err, body.error_description].filter(Boolean).join(': ');
  else detail = `HTTP ${res.status}`;
  throw new GmailError(`${what} failed: ${detail}`);
}

/**
 * Read every Candiboost Sent thread in full. Read-only: refresh the access
 * token, list `in:sent` threads with the subject, get each one.
 * @param {{fetch?: Function, env?: Record<string,string|undefined>}} [options]
 */
export async function fetchSentThreads({ fetch: fetchFn = globalThis.fetch, env = process.env } = {}) {
  const missing = GMAIL_ENV.filter((name) => !env[name]);
  if (missing.length) throw new GmailError(`missing ${missing.join(', ')}`);
  const token = await googleJson(fetchFn, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  }, 'Gmail token refresh');
  if (!token.access_token) throw new GmailError('Gmail token refresh failed: no access token returned');
  const init = { headers: { Authorization: `Bearer ${token.access_token}` } };

  const ids = [];
  let pageToken = null;
  do {
    let url = `${GMAIL_API}/threads?q=${encodeURIComponent(QUERY)}&maxResults=100`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const page = await googleJson(fetchFn, url, init, 'Gmail threads.list');
    for (const t of page.threads ?? []) ids.push(t.id);
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);

  const threads = [];
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const batch = ids.slice(i, i + FETCH_BATCH);
    threads.push(...await Promise.all(batch.map((id) => googleJson(fetchFn, `${GMAIL_API}/threads/${encodeURIComponent(id)}?format=full`, init, `Gmail threads.get ${id}`))));
  }
  return threads;
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}

function readTrackerRows(root) {
  const path = resolveTrackerPath(root);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

function readContactEmails(path) {
  const emails = new Set();
  if (!existsSync(path)) return emails;
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const email = unescapeFormulaCell((line.split('\t')[5] ?? '').trim()).toLowerCase();
    if (email) emails.add(email);
  }
  return emails;
}

function readReplyIds(path) {
  if (!existsSync(path)) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    fail(`${path}: ${e.message}`);
  }
  if (!Array.isArray(parsed)) fail(`${path} is not a JSON array`);
  return new Set(parsed.map((c) => c?.message_id).filter(Boolean));
}

function pendingAdditions(root) {
  const dir = join(root, 'batch', 'tracker-additions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.tsv')).sort();
}

function renderSummary(out) {
  const lines = [
    `Candiboost sync${out.dryRun ? ' (dry-run)' : ''}: ${out.threads} threads, ${out.sends} sends, ${out.skipped.length} skipped`,
    `  statuses: ${out.bounced} bounced, ${out.replied} replied`,
    `  ${out.new} new records, ${out.newTrackerRows} new tracker rows, ${out.alreadyTracked.length} already tracked, ${out.statusChanges} status changes`,
    `  Radar: ${out.radar.matched} matched, ${out.radar.unmatched} unmatched, ${out.radar.ambiguous} ambiguous`,
    `  contacts: ${out.contacts.new} new (${out.contacts.noName} without a name); reply candidates: ${out.replyCandidates.new} new`,
  ];
  if (out.skipped.length) lines.push(`  skipped: ${out.skipped.map((s) => `${s.thread_id} (${s.reason})`).join(', ')}`);
  if (out.newCompanies.length) lines.push(`  new tracker rows: ${out.newCompanies.join(', ')}`);
  if (out.alreadyTracked.length) lines.push(`  already tracked: ${out.alreadyTracked.map((a) => `${a.company} (#${a.row})`).join(', ')}`);
  return lines.join('\n');
}

async function runSync(args, root) {
  const dryRun = args.includes('--dry-run');
  const threadsFile = flagValue(args, '--threads-file');

  const pending = pendingAdditions(root);
  if (pending.length) {
    fail(`batch/tracker-additions/ already holds ${pending.join(', ')}: run node merge-tracker.mjs first`);
  }

  let threads;
  if (threadsFile !== undefined) {
    try {
      threads = JSON.parse(readFileSync(threadsFile, 'utf-8'));
    } catch (e) {
      fail(`${threadsFile}: ${e.message}`);
    }
    if (!Array.isArray(threads)) fail(`${threadsFile} is not a JSON array of threads`);
  } else {
    const missing = GMAIL_ENV.filter((name) => !process.env[name]);
    if (missing.length) {
      fail(`missing ${missing.join(', ')}: run node --env-file=.env candiboost-sync.mjs sync`);
    }
    try {
      threads = await fetchSentThreads({ env: process.env });
    } catch (e) {
      if (e instanceof GmailError) fail(e.message);
      throw e;
    }
  }

  const radar = readRegistry(registryPath(root));
  const trackerRows = readTrackerRows(root);
  const registry = readTable(join(root, 'data', 'candiboost.tsv'), REGISTRY_SPEC);
  const parsed = threads.map((t) => parseThread(t));
  const plan = planSync(registry.rows, parsed, { prospectIndex: buildProspectIndex(radar.rows), trackerRows });

  const contactEmails = readContactEmails(join(root, 'data', 'contacts.tsv'));
  const newContacts = [];
  for (const r of plan.newRecords) {
    const email = r.to_email.toLowerCase();
    if (!r.contact_name || contactEmails.has(email)) continue;
    contactEmails.add(email);
    newContacts.push(r);
  }
  const replyIds = readReplyIds(join(root, 'data', 'reply-candidates.json'));
  const newReplies = [];
  for (const { thread_id, reply } of plan.replies) {
    if (replyIds.has(reply.message_id)) continue;
    replyIds.add(reply.message_id);
    newReplies.push({ thread_id, reply });
  }

  const statusOf = (row) => trackerRows.find((t) => t.num === row)?.status ?? 'Applied';
  const okThreads = parsed.filter((p) => p.ok);
  const out = {
    dryRun,
    threads: threads.length,
    sends: plan.sends,
    skipped: plan.skipped,
    bounced: okThreads.filter((p) => p.status === 'bounced').length,
    replied: okThreads.filter((p) => p.status === 'replied').length,
    new: plan.newRecords.length,
    statusChanges: plan.statusChanges.length,
    newTrackerRows: plan.trackerPlan.newCompanies.length,
    newCompanies: plan.trackerPlan.newCompanies.map((c) => c.company),
    alreadyTracked: plan.trackerPlan.alreadyTracked.map((a) => ({
      company: a.company,
      row: a.row,
      command: `node set-status.mjs --row ${a.row} "${statusOf(a.row)}" --note "candiboost send ${a.date}"`,
    })),
    radar: plan.radar,
    contacts: { new: newContacts.length, noName: plan.newRecords.filter((r) => !r.contact_name).length },
    replyCandidates: { new: newReplies.length },
  };
  if (!dryRun) fail('the real sync is not implemented yet', CLI_EXIT.USAGE);
  console.log(args.includes('--summary') ? renderSummary(out) : JSON.stringify(out, null, 2));
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const root = getCareerOpsRoot();
  const [command] = positionals(args);
  if (command === 'sync') await runSync(args, root);
  else fail('first argument must be sync, pick or mark (see --help)');
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}

export { CODE_ROOT };
