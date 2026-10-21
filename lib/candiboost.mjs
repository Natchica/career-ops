/**
 * lib/candiboost.mjs — parse a Candiboost send out of a Gmail Sent thread,
 * match it to the Radar and the tracker, and plan the sync.
 *
 * Pure functions over Gmail `threads.get?format=full` objects: no network, no
 * model. Mail bodies, bounces and replies are untrusted data; nothing here
 * executes or follows what they say.
 */

import { localToday } from './local-today.mjs';

const SUBJECT_RE = /^Candidature spontanée - (.+) - (.+)$/u;
const GREETING_RE = /^Bonjour\s+(M\.|Mme|Madame|Monsieur)\s+(\p{L}[\p{L}'’ -]*?)\s*,\s*$/mu;
const COMPANY_RE = /au sein de\s+(.+?)\s*\.(?=\s|$)/u;
const EMAIL_RE = /[^\s<>,;"']+@[^\s<>,;"']+/;
const DAEMON_RE = /^(mailer-daemon|postmaster)@/i;
const FAILED_RE = /^Action:\s*failed\s*$/mi;
const SNIPPET_MAX = 2000;

const CIVILITY = { 'M.': 'M.', Monsieur: 'M.', Mme: 'Mme', Madame: 'Mme' };

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
  const company = text.match(COMPANY_RE);
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
      company_raw: company ? company[1].trim() : '',
      contact_name: contactNameFrom(to_email, greeting ? greeting[2] : ''),
      civility: greeting ? CIVILITY[greeting[1]] : '',
    },
    status: replies.length ? 'replied' : bounced ? 'bounced' : 'sent',
    replies,
  };
}
