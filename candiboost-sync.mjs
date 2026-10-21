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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { unescapeFormulaCell } from './lib/tsv-formula-escape.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { CLI_EXIT, normalizeCompany, writeFileAtomic } from './tracker-utils.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { readRegistry, registryPath } from './radar/registry.mjs';
import { releaseReportNumbers, reserveReportNumbers } from './reserve-report-num.mjs';
import { appendCandidate } from './paste-reply.mjs';
import { slugifyCompany } from './lib/tracker-addition.mjs';
import {
  REGISTRY_COLUMNS, additionTsv, buildProspectIndex, contactLine, parseThread, planSync, readTable, updateTable,
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

const MAX_RESERVE = 50;

/**
 * Reserve `count` report numbers in chunks of at most 50. A failure releases
 * the chunks already taken. The returned array carries its chunks in a
 * non-enumerable `chunks` property so the caller can release each one.
 */
export async function reserveInChunks(count, reserveFn, releaseFn) {
  const chunks = [];
  try {
    for (let left = count; left > 0; left -= MAX_RESERVE) chunks.push(await reserveFn(Math.min(MAX_RESERVE, left)));
  } catch (e) {
    for (const chunk of chunks) await releaseFn(chunk);
    throw e;
  }
  const numbers = chunks.flat();
  Object.defineProperty(numbers, 'chunks', { value: chunks });
  return numbers;
}

const rangeOf = (chunk) => (chunk.length === 1 ? String(chunk[0]) : `${chunk[0]}-${chunk[chunk.length - 1]}`);

function runScript(script, args, root) {
  return spawnSync(process.execPath, [join(CODE_ROOT, script), ...args], {
    cwd: CODE_ROOT,
    encoding: 'utf-8',
    timeout: 300_000,
    env: { ...process.env, CAREER_OPS_ROOT: root },
  });
}

const CONTACTS_HEADER = '# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes';

async function appendContacts(path, records, numOf) {
  mkdirSync(dirname(path), { recursive: true });
  return withPipelineLock(path, () => {
    let text = existsSync(path) ? readFileSync(path, 'utf-8') : `${CONTACTS_HEADER}\n`;
    if (!text.endsWith('\n')) text += '\n';
    const emails = readContactEmails(path);
    let added = 0;
    for (const r of records) {
      const email = r.to_email.toLowerCase();
      if (!r.contact_name || emails.has(email)) continue;
      emails.add(email);
      text += `${contactLine({ name: r.contact_name, company: r.company, email: r.to_email, tracker: numOf.get(r.thread_id), date: r.sent_at })}\n`;
      added++;
    }
    if (added) writeFileAtomic(path, text);
    return added;
  });
}

/**
 * The real write, in an order where every step is idempotent or deduplicated:
 * reserve, TSVs, merge-tracker, confirm, release, set-status notes, contacts,
 * reply candidates, registry (last). A crash before the registry write heals on
 * the next run.
 */
async function writeSync({ root, plan, trackerRows, newReplies }) {
  const groups = plan.trackerPlan.newCompanies;
  const numOf = new Map();
  const failed = new Set();
  const result = { reservations: [], merged: 0, mergeFailed: [], noteFailed: [] };

  if (groups.length) {
    const reserveFn = (n) => reserveReportNumbers(n, { rootDir: root });
    const releaseFn = (chunk) => releaseReportNumbers(chunk, { rootDir: root });
    const numbers = await reserveInChunks(groups.length, reserveFn, releaseFn);
    result.reservations = numbers.chunks.map(rangeOf);
    try {
      const additions = join(root, 'batch', 'tracker-additions');
      mkdirSync(additions, { recursive: true });
      groups.forEach((g, i) => {
        g.num = numbers[i];
        writeFileSync(join(additions, `${g.num}-${slugifyCompany(g.company)}.tsv`), additionTsv({ num: g.num, date: g.date, company: g.company }));
      });
      const merge = runScript('merge-tracker.mjs', [], root);
      if (merge.error) throw merge.error;
      const after = readTrackerRows(root);
      for (const g of groups) {
        const row = after.find((t) => t.num === g.num && normalizeCompany(t.company) === normalizeCompany(g.company));
        if (row) {
          result.merged++;
          for (const id of g.threadIds) numOf.set(id, g.num);
        } else {
          result.mergeFailed.push(g.company);
          for (const id of g.threadIds) failed.add(id);
        }
      }
    } finally {
      for (const chunk of numbers.chunks) await releaseFn(chunk);
    }
  }

  for (const a of plan.trackerPlan.alreadyTracked) {
    const status = trackerRows.find((t) => t.num === a.row)?.status || 'Applied';
    const r = runScript('set-status.mjs', ['--row', String(a.row), status, '--note', `candiboost send ${a.date}`], root);
    if (r.status === 0) for (const id of a.threadIds) numOf.set(id, a.row);
    else {
      result.noteFailed.push(a.company);
      for (const id of a.threadIds) failed.add(id);
    }
  }

  const records = plan.newRecords.filter((r) => !failed.has(r.thread_id));
  await appendContacts(join(root, 'data', 'contacts.tsv'), records, numOf);

  const repliesPath = join(root, 'data', 'reply-candidates.json');
  for (const { thread_id, reply } of newReplies) {
    if (!failed.has(thread_id)) await appendCandidate(reply, repliesPath);
  }

  await updateTable(join(root, 'data', 'candiboost.tsv'), REGISTRY_SPEC, (fresh) => {
    const change = new Map(plan.statusChanges.map((c) => [c.thread_id, c.to]));
    const rows = fresh.rows.map((r) => (change.has(r.thread_id) ? { ...r, status: change.get(r.thread_id) } : r));
    for (const r of records) rows.push({ ...r, tracker: String(numOf.get(r.thread_id)) });
    return { rows };
  });
  return result;
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
  if (!dryRun) {
    const written = await writeSync({ root, plan, trackerRows, newReplies });
    Object.assign(out, written);
  }
  console.log(args.includes('--summary') ? renderSummary(out) : JSON.stringify(out, null, 2));
  if (out.mergeFailed?.length || out.noteFailed?.length) process.exit(CLI_EXIT.USAGE);
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
