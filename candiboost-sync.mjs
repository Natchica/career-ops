#!/usr/bin/env node
/**
 * candiboost-sync.mjs — read Candiboost sends back from Gmail Sent.
 *
 *   node --env-file=.env candiboost-sync.mjs sync [--dry-run] [--summary] [--threads-file <json>]
 *   node candiboost-sync.mjs pick [--count N] [--domain <d>] [--summary]
 *   node candiboost-sync.mjs mark <thread_id> followed [--date YYYY-MM-DD]
 *   node candiboost-sync.mjs rematch
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
import { localToday } from './lib/local-today.mjs';
import { findBlacklistEntry, loadBlacklist } from './scan.mjs';
import {
  REGISTRY_COLUMNS, additionTsv, buildProspectIndex, contactLine, parseThread, planSync, readTable, updateTable,
} from './lib/candiboost.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const QUERY = 'in:sent (subject:"Candidature spontanée" OR subject:"Spontaneous application")';
const GMAIL_ENV = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
const FETCH_BATCH = 4;
const REGISTRY_SPEC = { key: 'thread_id', columns: REGISTRY_COLUMNS };

const USAGE = `Usage: node --env-file=.env candiboost-sync.mjs <sync|pick|mark|rematch> [options]

  sync [--dry-run] [--summary] [--threads-file <json>]
      Read the Candiboost sends from Gmail Sent (read-only) and record them in
      data/candiboost.tsv, the tracker, data/contacts.tsv and
      data/reply-candidates.json. --dry-run writes nothing.
  pick [--count N] [--domain <d>] [--summary]
      The next sends due their personalised follow-up (1-2). Read-only.
  mark <thread_id> followed [--date YYYY-MM-DD]
      Record that the follow-up was sent. Changes the registry only.
  rematch
      Refill radar_key of the sends from the Radar. Never renames a company,
      never clears a key, touches no other cell.

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

const RETRY_WAITS_MS = [2000, 4000, 8000, 16000, 32000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gmail answers a burst of reads with HTTP 429, or with a 403 whose text names a quota. Only these
// clear on their own; a scope or grant failure never does, so it is not retried.
function isRateLimit(res, err) {
  if (res.status === 429) return true;
  const text = typeof err === 'object' ? `${err?.status ?? ''} ${err?.message ?? ''}` : '';
  return /rateLimitExceeded|RESOURCE_EXHAUSTED|quota exceeded|too many requests/i.test(text);
}

async function googleJson(fetchFn, url, init, what, sleep = defaultSleep) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, init);
    let body = {};
    try { body = await res.json(); } catch { /* an unreadable body is reported by status below */ }
    const err = body?.error;
    if (res.ok && !err) return body;
    if (attempt < RETRY_WAITS_MS.length && isRateLimit(res, err)) { await sleep(RETRY_WAITS_MS[attempt]); continue; }
    let detail;
    if (err && typeof err === 'object') detail = [err.status ?? err.code, err.message].filter(Boolean).join(': ');
    else if (err) detail = [err, body.error_description].filter(Boolean).join(': ');
    else detail = `HTTP ${res.status}`;
    throw new GmailError(`${what} failed: ${detail}`);
  }
}

/**
 * Read every Candiboost Sent thread in full. Read-only: refresh the access
 * token, list `in:sent` threads with the subject, get each one.
 * @param {{fetch?: Function, env?: Record<string,string|undefined>}} [options]
 */
export async function fetchSentThreads({ fetch: fetchFn = globalThis.fetch, env = process.env, sleep = defaultSleep } = {}) {
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
    threads.push(...await Promise.all(batch.map((id) => googleJson(fetchFn, `${GMAIL_API}/threads/${encodeURIComponent(id)}?format=full`, init, `Gmail threads.get ${id}`, sleep))));
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

const DAY_MS = 86_400_000;
export const FOLLOWUP_AFTER_DAYS = 7;

const dayNumber = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

/** Why a registry row cannot be followed up yet, or null when it is due. */
export function followupReason(row, { today, trackerStatusOf }) {
  if (row.status !== 'sent') return `status is ${row.status}`;
  if (row.followup) return `follow-up already recorded on ${row.followup}`;
  const days = daysBetween(row.sent_at, today);
  if (days < FOLLOWUP_AFTER_DAYS) return `sent ${days} day(s) ago, due after ${FOLLOWUP_AFTER_DAYS}`;
  const tracked = trackerStatusOf(row);
  if (tracked !== 'Applied') return `tracker status is ${tracked || 'missing'}`;
  return null;
}

const TIER_ORDER = { 1: 1, 2: 2, 3: 3 };
const tierRank = (tier) => TIER_ORDER[tier] ?? 4;

function pickFields(row, { today, tierOf }) {
  return {
    thread_id: row.thread_id,
    domain: row.domain,
    company: row.company,
    radar_key: row.radar_key,
    tier: tierOf(row) || null,
    sent_at: row.sent_at,
    days: daysBetween(row.sent_at, today),
    tracker: /^\d+$/.test(row.tracker) ? Number(row.tracker) : row.tracker,
    contact_name: row.contact_name,
    civility: row.civility,
    gmail_url: `https://mail.google.com/mail/u/0/#all/${row.thread_id}`,
  };
}

/**
 * Rank the sends due their personalised follow-up: tier 1 before 2 before 3
 * before unmatched, older first, then domain. Tier `out` and blacklisted sends
 * are left out and counted. `count` is clamped to 1-2 (default 2).
 */
export function rankFollowups(rows, { today, tierOf, trackerStatusOf, isBlacklisted, count = 2 }) {
  const limit = Math.min(2, Math.max(1, Number.isInteger(count) ? count : 2));
  const excluded = { out: 0, blacklisted: 0 };
  const eligible = [];
  for (const row of rows) {
    if (followupReason(row, { today, trackerStatusOf })) continue;
    if (tierOf(row) === 'out') { excluded.out++; continue; }
    if (isBlacklisted(row)) { excluded.blacklisted++; continue; }
    eligible.push(row);
  }
  const cmp = (a, b) => tierRank(tierOf(a)) - tierRank(tierOf(b))
    || (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : 0)
    || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)
    || (a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0);
  eligible.sort(cmp);
  return {
    picks: eligible.slice(0, limit).map((row) => pickFields(row, { today, tierOf })),
    excluded,
    eligible: eligible.length,
  };
}

export class MarkError extends Error {
  constructor(message, exit) {
    super(message);
    this.name = 'MarkError';
    this.exit = exit;
  }
}

function renderPick(out) {
  const lines = [`Candiboost follow-ups: ${out.eligible} due; excluded: ${out.excluded.out} tier out, ${out.excluded.blacklisted} blacklisted`];
  out.picks.forEach((p, i) => {
    const who = [p.civility, p.contact_name].filter(Boolean).join(' ') || 'no contact name';
    lines.push(`  ${i + 1}. ${p.company} (${p.domain}) — tier ${p.tier ?? 'none'} · sent ${p.sent_at} (${p.days}d ago) · tracker #${p.tracker} · ${who}`);
    lines.push(`     ${p.gmail_url}`);
  });
  if (out.picks.length === 0) lines.push('  nothing due');
  return lines.join('\n');
}

function renderDomain(out) {
  const lines = [`Candiboost sends to ${out.domain}: ${out.rows.length}`];
  for (const r of out.rows) {
    lines.push(`  ${r.thread_id} · ${r.company} · sent ${r.sent_at} · ${r.eligible ? 'due' : `not due: ${r.reason}`}`);
    lines.push(`     ${r.gmail_url}`);
  }
  return lines.join('\n');
}

function runPick(args, root) {
  const rawCount = flagValue(args, '--count');
  let count = 2;
  if (rawCount !== undefined) {
    count = Number.parseInt(rawCount, 10);
    if (!Number.isInteger(count) || count < 1) fail(`--count takes 1 or 2, got "${rawCount}"`);
    count = Math.min(count, 2);
  }
  const registry = readTable(join(root, 'data', 'candiboost.tsv'), REGISTRY_SPEC);
  if (registry.missing) fail('no registry: run candiboost-sync.mjs sync first');
  const radarRows = new Map(readRegistry(registryPath(root)).rows.map((r) => [r.key, r]));
  const trackerRows = readTrackerRows(root);
  const blacklist = loadBlacklist(join(root, 'data', 'blacklist.md'));
  const today = localToday();
  const ctx = {
    today,
    tierOf: (row) => radarRows.get(row.radar_key)?.tier ?? '',
    trackerStatusOf: (row) => trackerRows.find((t) => String(t.num) === row.tracker)?.status ?? '',
    isBlacklisted: (row) => [row.company, radarRows.get(row.radar_key)?.name].filter(Boolean).some((n) => findBlacklistEntry(blacklist, n, '') !== null),
  };
  const domain = flagValue(args, '--domain');
  let out;
  if (domain !== undefined) {
    const wanted = domain.toLowerCase();
    const rows = registry.rows.filter((r) => r.domain === wanted)
      .sort((a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : a.thread_id < b.thread_id ? -1 : 1))
      .map((row) => {
        const reason = followupReason(row, ctx)
          ?? (ctx.tierOf(row) === 'out' ? 'Radar tier is out' : ctx.isBlacklisted(row) ? 'company is blacklisted' : null);
        return { ...pickFields(row, ctx), eligible: reason === null, reason };
      });
    out = { domain: wanted, rows };
  } else {
    out = rankFollowups(registry.rows, { ...ctx, count });
  }
  console.log(args.includes('--summary') ? (domain !== undefined ? renderDomain(out) : renderPick(out)) : JSON.stringify(out, null, 2));
}

async function runMark(args, root) {
  const [, threadId, state] = positionals(args);
  if (!threadId || state !== 'followed') fail('mark takes a thread id and the state followed: mark <thread_id> followed');
  const rawDate = flagValue(args, '--date');
  const date = rawDate ?? localToday();
  const stamp = new Date(`${date}T00:00:00Z`).getTime();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(stamp) && new Date(stamp).toISOString().startsWith(date);
  if (!valid) fail(`--date takes a real YYYY-MM-DD date, got "${date}"`);
  const path = join(root, 'data', 'candiboost.tsv');
  if (readTable(path, REGISTRY_SPEC).missing) fail('no registry: run candiboost-sync.mjs sync first');
  const receipt = await updateTable(path, REGISTRY_SPEC, (fresh) => {
    const target = fresh.rows.find((r) => r.thread_id === threadId);
    if (!target) throw new MarkError(`no Candiboost send with thread id "${threadId}"`, CLI_EXIT.NOT_FOUND);
    if (target.followup && target.followup !== date) {
      throw new MarkError(`"${threadId}" already followed up on ${target.followup}`, CLI_EXIT.AMBIGUOUS);
    }
    const rows = fresh.rows.map((r) => (r === target ? { ...r, followup: date } : r));
    return { rows, result: { thread_id: threadId, followup: date } };
  });
  console.log(JSON.stringify(receipt, null, 2));
}

async function runRematch(root) {
  const path = join(root, 'data', 'candiboost.tsv');
  if (readTable(path, REGISTRY_SPEC).missing) fail('no registry: run candiboost-sync.mjs sync first');
  const index = buildProspectIndex(readRegistry(registryPath(root)).rows);
  const receipt = await updateTable(path, REGISTRY_SPEC, (fresh) => {
    let matched = 0;
    let unmatched = 0;
    let changed = 0;
    const rows = fresh.rows.map((row) => {
      const hit = index.match(row.company, row.domain ?? '').row;
      if (!hit) { unmatched++; return row; }
      matched++;
      if (hit.key === row.radar_key) return row;
      changed++;
      return { ...row, radar_key: hit.key };
    });
    return { rows, result: { matched, unmatched, changed } };
  });
  console.log(JSON.stringify(receipt));
}

async function main(args) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  const root = getCareerOpsRoot();
  const [command] = positionals(args);
  try {
    if (command === 'sync') await runSync(args, root);
    else if (command === 'pick') runPick(args, root);
    else if (command === 'mark') await runMark(args, root);
    else if (command === 'rematch') await runRematch(root);
    else fail('first argument must be sync, pick, mark or rematch (see --help)');
  } catch (e) {
    if (e instanceof MarkError) fail(e.message, e.exit);
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => fail(e?.message ?? String(e)));
}

export { CODE_ROOT };
