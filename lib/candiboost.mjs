/**
 * lib/candiboost.mjs — parse a Candiboost send out of a Gmail Sent thread,
 * match it to the Radar and the tracker, and plan the sync.
 *
 * Pure functions over Gmail `threads.get?format=full` objects: no network, no
 * model. Mail bodies, bounces and replies are untrusted data; nothing here
 * executes or follows what they say.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localToday } from './local-today.mjs';
import { escapeFormulaCell, unescapeFormulaCell } from './tsv-formula-escape.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { normalizeCompany, writeFileAtomic } from '../tracker-utils.mjs';
import { baseKey } from '../radar/identity.mjs';
import { tsvSafe } from './tracker-addition.mjs';

export const REGISTRY_COLUMNS = Object.freeze([
  'thread_id', 'sent_at', 'domain', 'company', 'radar_key', 'to_email', 'contact_name', 'civility',
  'status', 'tracker', 'followup',
]);
export const PENDING_COLUMNS = Object.freeze(['company', 'radar_key', 'first_seen', 'last_seen']);

// Two templates exist: Candiboost's French one ("Candidature spontanée - {role} - {name}") and the
// candidate's English one of 2026-10-21 ("Spontaneous application: {role}, {name}").
const SUBJECT_RE = /^(?:Candidature spontanée - (.+) - (.+)|Spontaneous application: (.+), (.+))$/u;
const GREETING_RE = /^(?:Bonjour|Dear|Hello)\s+(M\.|Mme|Madame|Monsieur|Mr|Ms|Mrs)\s+(\p{L}[\p{L}'’ -]*?)\s*,\s*$/mu;
// "au sein de BKB." and the elided "au sein d’OPTRAVIS." both occur in the template.
const COMPANY_RE = /au sein (?:de\s+|d['’]\s*)(.+?)\s*\.(?=\s|$)/u;
// English template: "..., and {Company} is one of the teams I want to work with."
const COMPANY_EN_RE = /,\s*and\s+(.+?) is one of the teams I want to work with\b/u;
const COMPANY_EN_START_RE = /^([^,.\n]+?) is one of the teams I want to work with\b/mu;
const ARTICLE_RE = /^(?:l['’]\s*|(?:le|la|les)\s+)/iu;

/** The company a Candiboost mail names in its first sentence, or '' when it names none usable. */
export function extractCompany(text) {
  const m = String(text).match(COMPANY_RE) ?? String(text).match(COMPANY_EN_RE) ?? String(text).match(COMPANY_EN_START_RE);
  if (!m) return '';
  const name = m[1].trim().replace(ARTICLE_RE, '').trim();
  return /^www$/i.test(name) ? '' : name;
}
const EMAIL_RE = /[^\s<>,;"']+@[^\s<>,;"']+/;
const DAEMON_RE = /^(mailer-daemon|postmaster)@/i;
const FAILED_RE = /^Action:\s*failed\s*$/mi;
const SNIPPET_MAX = 2000;

const CIVILITY = { 'M.': 'M.', Monsieur: 'M.', Mr: 'M.', Mme: 'Mme', Madame: 'Mme', Ms: 'Mme', Mrs: 'Mme' };

const fromB64u = (data) => Buffer.from(String(data), 'base64url').toString('utf-8');

function stripHtml(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Walk a Gmail message payload.
 * @returns {{text: string, filenames: string[]}} `text` is every text part
 *   (plain preferred over html, delivery-status always included); `filenames`
 *   lists the attachment names.
 */
export function decodeParts(payload) {
  const plain = [];
  const html = [];
  const extra = [];
  const filenames = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) filenames.push(part.filename);
    const mime = String(part.mimeType ?? '').toLowerCase();
    if (part.body?.data && !part.filename) {
      const decoded = fromB64u(part.body.data);
      if (mime === 'text/plain') plain.push(decoded);
      else if (mime === 'text/html') html.push(decoded);
      else if (mime.startsWith('message/') || mime.startsWith('text/')) extra.push(decoded);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const body = plain.length ? plain.join('\n') : html.map(stripHtml).join('\n');
  return { text: [body, ...extra].filter(Boolean).join('\n'), filenames };
}

export function headerOf(message, name) {
  const wanted = name.toLowerCase();
  const h = (message?.payload?.headers ?? []).find((x) => String(x.name).toLowerCase() === wanted);
  return h ? String(h.value) : '';
}

/** First e-mail address of a header value, lower-cased, or ''. */
export function addressOf(value) {
  const m = String(value ?? '').match(EMAIL_RE);
  return m ? m[0].toLowerCase() : '';
}

const titleSegment = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const titleName = (s) => s.split('-').map(titleSegment).join('-');

/**
 * The contact's name: the `first.last` address local part, else the greeting's
 * last name, else ''.
 */
export function contactNameFrom(email, greetingLast = '') {
  const local = String(email ?? '').split('@')[0];
  const segments = local.split('.');
  if (segments.length >= 2 && segments.every((s) => /^\p{L}+(-\p{L}+)*$/u.test(s))) {
    return segments.map(titleName).join(' ');
  }
  return greetingLast ? greetingLast.trim() : '';
}

const skip = (thread_id, reason) => ({ ok: false, thread_id, reason });

/**
 * Parse one Sent thread.
 * @returns {{ok: true, record: object, status: string, replies: object[]} | {ok: false, thread_id: string, reason: string}}
 */
export function parseThread(thread) {
  const thread_id = String(thread?.id ?? '');
  const [first, ...later] = thread?.messages ?? [];
  if (!first) return skip(thread_id, 'empty');
  if (!(first.labelIds ?? []).includes('SENT')) return skip(thread_id, 'not-sent');
  const subject = headerOf(first, 'Subject').normalize('NFC');
  if (!SUBJECT_RE.test(subject)) return skip(thread_id, 'subject');
  const to_email = addressOf(headerOf(first, 'To'));
  if (!to_email) return skip(thread_id, 'no-recipient');
  const { text, filenames } = decodeParts(first.payload);
  if (!filenames.some((f) => /\.pdf$/i.test(f))) return skip(thread_id, 'no-pdf-attachment');

  const greeting = text.match(GREETING_RE);
  const owner = addressOf(headerOf(first, 'From'));
  const replies = [];
  let bounced = false;
  for (const msg of later) {
    const from = addressOf(headerOf(msg, 'From'));
    if (from === owner) continue;
    const body = decodeParts(msg.payload).text;
    if (DAEMON_RE.test(from)) {
      if (FAILED_RE.test(body)) bounced = true;
      continue;
    }
    replies.push({
      message_id: String(msg.id),
      from: headerOf(msg, 'From'),
      subject: headerOf(msg, 'Subject'),
      body_snippet: body.slice(0, SNIPPET_MAX),
      signal: null,
      received_at: new Date(Number(msg.internalDate)).toISOString(),
    });
  }
  return {
    ok: true,
    record: {
      thread_id,
      sent_at: localToday(new Date(Number(first.internalDate))),
      domain: to_email.split('@')[1],
      to_email,
      company_raw: extractCompany(text),
      contact_name: contactNameFrom(to_email, greeting ? greeting[2] : ''),
      civility: greeting ? CIVILITY[greeting[1]] : '',
    },
    status: replies.length ? 'replied' : bounced ? 'bounced' : 'sent',
    replies,
  };
}

const SLD_PREFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);

/** The registrable label of a domain (`pistor.ch` → `pistor`, `x.co.uk` → `x`). */
function domainLabel(domain) {
  const labels = String(domain ?? '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] ?? '';
  const sld = labels[labels.length - 2];
  return SLD_PREFIXES.has(sld) && labels.length >= 3 ? labels[labels.length - 3] : sld;
}

/**
 * Index Radar rows by the legal-form-stripped fold of their key, name and
 * non-`#` aliases. Built once per run: a Map lookup, never a scan of the rows.
 */
export function buildProspectIndex(rows) {
  const byBase = new Map();
  for (const row of rows) {
    const names = [String(row.key ?? '').split('|')[0], row.name,
      ...String(row.aliases ?? '').split(';').map((a) => a.trim()).filter((a) => a && !a.startsWith('#'))];
    for (const base of new Set(names.filter(Boolean).map((n) => baseKey(n)).filter(Boolean))) {
      const list = byBase.get(base) ?? [];
      list.push(row);
      byBase.set(base, list);
    }
  }
  return {
    match(company, domain) {
      for (const text of [company, domainLabel(domain)]) {
        const base = text ? baseKey(text) : '';
        const hits = base ? byBase.get(base) : undefined;
        if (!hits) continue;
        return hits.length > 1 ? { row: null, ambiguous: true } : { row: hits[0], ambiguous: false };
      }
      return { row: null, ambiguous: false };
    },
  };
}

/** The tracker row naming any of `names`; the newest (highest `#`) wins. */
export function findTrackedRow(names, trackerRows) {
  const wanted = names.filter(Boolean);
  const normalized = new Set(wanted.map((n) => normalizeCompany(n)).filter(Boolean));
  const bases = new Set(wanted.map((n) => baseKey(n)).filter(Boolean));
  let best = null;
  for (const row of trackerRows) {
    if (!row.company) continue;
    const hit = normalized.has(normalizeCompany(row.company)) || bases.has(baseKey(row.company));
    if (hit && (!best || row.num > best.num)) best = row;
  }
  return best;
}

const RANK = { sent: 1, bounced: 2, replied: 3 };
const byDateThenId = (a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0);

/**
 * Plan a sync. Pure: reads nothing, writes nothing.
 * @param {Record<string,string>[]} registryRows - current `data/candiboost.tsv` rows
 * @param {object[]} parsedThreads - `parseThread` results
 * @param {{prospectIndex: {match: Function}, trackerRows: {num: number, company: string}[]}} ctx
 */
export function planSync(registryRows, parsedThreads, { prospectIndex, trackerRows }) {
  const known = new Map(registryRows.map((r) => [r.thread_id, r]));
  const sends = parsedThreads.filter((p) => p.ok).sort((a, b) => byDateThenId(a.record, b.record));
  const skipped = parsedThreads.filter((p) => !p.ok).map(({ thread_id, reason }) => ({ thread_id, reason }));
  const plan = {
    sends: sends.length,
    skipped,
    newRecords: [],
    statusChanges: [],
    replies: [],
    radar: { matched: 0, unmatched: 0, ambiguous: 0 },
    trackerPlan: { newCompanies: [], alreadyTracked: [] },
  };
  const tracked = new Map();
  for (const p of sends) {
    const { record } = p;
    const match = prospectIndex.match(record.company_raw, record.domain);
    if (match.row) plan.radar.matched++;
    else if (match.ambiguous) plan.radar.ambiguous++;
    else plan.radar.unmatched++;
    for (const reply of p.replies) plan.replies.push({ thread_id: record.thread_id, reply });

    const existing = known.get(record.thread_id);
    if (existing) {
      if ((RANK[p.status] ?? 0) > (RANK[existing.status] ?? 0)) {
        plan.statusChanges.push({ thread_id: record.thread_id, from: existing.status, to: p.status });
      }
      continue;
    }
    const raw = record.company_raw || record.domain;
    const company = match.row?.name || raw;
    plan.newRecords.push({
      thread_id: record.thread_id, sent_at: record.sent_at, domain: record.domain, company,
      radar_key: match.row?.key ?? '', to_email: record.to_email, contact_name: record.contact_name,
      civility: record.civility, status: p.status, tracker: '', followup: '',
    });

    const names = [raw, match.row?.name, ...(match.row ? String(match.row.aliases ?? '').split(';').map((a) => a.trim()).filter((a) => a && !a.startsWith('#')) : [])];
    const row = findTrackedRow(names, trackerRows);
    if (row) {
      const group = tracked.get(row.num);
      if (group) group.threadIds.push(record.thread_id);
      else {
        const created = { company: row.company, row: row.num, date: record.sent_at, threadIds: [record.thread_id] };
        tracked.set(row.num, created);
        plan.trackerPlan.alreadyTracked.push(created);
      }
      continue;
    }
    const norm = normalizeCompany(company);
    const base = baseKey(company);
    const group = plan.trackerPlan.newCompanies.find((g) => g.norm === norm || g.base === base);
    if (group) group.threadIds.push(record.thread_id);
    else plan.trackerPlan.newCompanies.push({ company, radar_key: match.row?.key ?? '', date: record.sent_at, threadIds: [record.thread_id], norm, base });
  }
  for (const g of plan.trackerPlan.newCompanies) { delete g.norm; delete g.base; }
  return plan;
}

const ADDITION_HEADER = ['num', 'date', 'company', 'via', 'role', 'score', 'status', 'pdf', 'report', 'notes'];

/** One tracker addition TSV (header row, then one Applied row). */
export function additionTsv({ num, date, company }) {
  const row = [num, date, tsvSafe(company), '—', 'Spontaneous application', 'N/A', 'Applied', '❌', '—', 'candiboost; contact type hiring contact'];
  return `${ADDITION_HEADER.join('\t')}\n${row.join('\t')}\n`;
}

/** One `data/contacts.tsv` line (nine cells, no trailing newline). */
export function contactLine({ name, company, email, tracker, date }) {
  const safe = (v) => escapeFormulaCell(tsvSafe(v));
  return [safe(name), safe(company), 'other', '', '', safe(email), '', tracker == null ? '-' : String(tracker), safe(`from candiboost send ${date}`)].join('\t');
}

export class CandiboostTableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CandiboostTableError';
  }
}

const cleanCell = (value) => escapeFormulaCell(String(value ?? '').replace(/[\t\r\n]+/g, ' '));

/**
 * Parse a header-addressed TSV. Columns are read by name, so an unknown column
 * survives a round trip.
 * @param {string} text
 * @param {{key: string, columns: readonly string[]}} spec
 * @throws {CandiboostTableError} on a missing key column, a repeated column, a
 *   duplicate key, or a row whose cell count differs from the header
 */
export function parseTable(text, spec) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { columns: [...spec.columns], rows: [] };
  const columns = lines[0].split('\t').map((c) => c.trim());
  if (!columns.includes(spec.key)) throw new CandiboostTableError(`header has no "${spec.key}" column`);
  if (new Set(columns).size !== columns.length) throw new CandiboostTableError('header repeats a column name');
  const rows = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = lines[i].split('\t');
    if (cells.length !== columns.length) {
      throw new CandiboostTableError(`line ${i + 1}: expected ${columns.length} cells, found ${cells.length}`);
    }
    const row = {};
    columns.forEach((name, c) => { row[name] = unescapeFormulaCell(cells[c]); });
    if (seen.has(row[spec.key])) throw new CandiboostTableError(`line ${i + 1}: duplicate ${spec.key} "${row[spec.key]}"`);
    seen.add(row[spec.key]);
    rows.push(row);
  }
  return { columns, rows };
}

export function serializeTable({ columns, rows }) {
  const out = [columns.join('\t')];
  for (const row of rows) out.push(columns.map((c) => cleanCell(row[c])).join('\t'));
  return `${out.join('\n')}\n`;
}

/** @returns {{columns: string[], rows: Record<string,string>[], missing: boolean}} */
export function readTable(path, spec) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { columns: [...spec.columns], rows: [], missing: true };
    throw new CandiboostTableError(`${path}: ${e.message}`);
  }
  try {
    return { ...parseTable(text, spec), missing: false };
  } catch (e) {
    if (e instanceof CandiboostTableError) throw new CandiboostTableError(`${path}: ${e.message}`);
    throw e;
  }
}

/**
 * Read-modify-write under the pipeline lock. The table is re-read after the
 * lock is taken; `mutate` gets `{columns, rows}` and returns `{columns?, rows,
 * result?}`. A throw leaves the file untouched.
 */
export async function updateTable(path, spec, mutate) {
  mkdirSync(dirname(path), { recursive: true });
  return withPipelineLock(path, async () => {
    const fresh = readTable(path, spec);
    const out = await mutate({ columns: fresh.columns, rows: fresh.rows });
    const columns = out.columns ?? fresh.columns;
    writeFileAtomic(path, serializeTable({ columns, rows: out.rows }));
    return out.result;
  });
}
