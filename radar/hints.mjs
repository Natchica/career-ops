/**
 * radar/hints.mjs — relevance hints for a Prospect, kept apart from its tech signals.
 *
 * `signals` counts independent sources that say a firm builds software. A hint
 * says something about this candidate's search instead: whether the firm shows
 * Java or Rust in its public code or on its own site, and whether its careers
 * page invites unsolicited applications. Hints are read from public pages by
 * `radar-enrich.mjs` and stored as `;`-separated tokens in the `hints` cell:
 *
 *   gh:java  gh:rust       a recent, non-fork GitHub repository in that stack
 *   site:java  site:rust   the home or careers page names that stack
 *   site:open-apps         the careers page invites unsolicited applications
 *   checked:YYYY-MM-DD     the Prospect was probed on that day (never scored)
 *
 * Hints only order Prospects inside one zone and country group, so a Prospect
 * with a better zone is never overtaken by a hint.
 */

const DAY_MS = 86_400_000;
const RECENT_DAYS = 730;

export const STACK_HINTS = Object.freeze(['gh:java', 'gh:rust', 'site:java', 'site:rust']);
export const OPEN_APPS_HINT = 'site:open-apps';

const OPEN_APPS = new RegExp([
  'initiativ[\\s-]?bewerbung', 'spontan[\\s-]?bewerbung', 'blindbewerbung',
  'unsolicited\\s+applications?', 'spontaneous\\s+applications?', 'open\\s+applications?',
  'speculative\\s+applications?', 'candidatures?\\s+spontan[ée]es?', 'apply\\s+on\\s+your\\s+own\\s+initiative',
  'auf\\s+eigene\\s+initiative\\s+bewerben',
].join('|'), 'i');
const JAVA = /\bjava\b(?!\s*script)/i;
const RUST = /\brust\b/i;

export const parseHints = (cell) => [...new Set(String(cell ?? '').split(';').map((s) => s.trim()).filter(Boolean))];

/** Stable output: stack hints, then the open-applications hint, then the rest sorted. */
export function formatHints(tokens) {
  const set = new Set(tokens);
  const first = [...STACK_HINTS, OPEN_APPS_HINT].filter((t) => set.has(t));
  const rest = [...set].filter((t) => !first.includes(t)).sort();
  return [...first, ...rest].join(';');
}

/** 0 to 2: one point for an open-applications invitation, one for any Java or Rust trace. */
export function hintScore(row) {
  const tokens = parseHints(row?.hints);
  const open = tokens.includes(OPEN_APPS_HINT) ? 1 : 0;
  const stack = tokens.some((t) => STACK_HINTS.includes(t)) ? 1 : 0;
  return open + stack;
}

/**
 * Stack tokens from an organisation's public repositories. A repository counts
 * when it is not a fork, not archived and was pushed within two years. The
 * language is read first; a repository with none set (an exam or a docs repo)
 * still counts when its name or a topic names the stack.
 */
export function repoHints(repos, now = new Date()) {
  const out = new Set();
  for (const repo of repos ?? []) {
    if (repo.fork || repo.archived) continue;
    const pushed = Date.parse(repo.pushed_at ?? '');
    if (!Number.isFinite(pushed) || now.getTime() - pushed > RECENT_DAYS * DAY_MS) continue;
    const words = [repo.name ?? '', ...(repo.topics ?? [])].join(' ');
    if (repo.language === 'Java' || /\bjava\b(?!\s*script)/i.test(words.replace(/[-_]/g, ' '))) out.add('gh:java');
    if (repo.language === 'Rust' || /\brust\b/i.test(words.replace(/[-_]/g, ' '))) out.add('gh:rust');
  }
  return [...out];
}

/** Hint tokens from the visible text of a home or careers page. */
export function pageHints(text) {
  const t = String(text ?? '');
  const out = [];
  if (JAVA.test(t)) out.push('site:java');
  if (RUST.test(t)) out.push('site:rust');
  if (OPEN_APPS.test(t)) out.push(OPEN_APPS_HINT);
  return out;
}

export function stripTags(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const CAREERS_SEGMENT = /^(karriere|careers?|jobs?|stellenangebote|offene-stellen|emplois?|recrutement|join-us|work-with-us)$/i;
const careersPath = (pathname) => pathname.split('/').some((segment) => CAREERS_SEGMENT.test(segment.replace(/\.[a-z]+$/i, '')));
const CAREERS_LABEL = /\b(karriere|careers?|jobs?|stellenangebote|offene stellen|emplois?|nous rejoindre|join us|work with us)\b/i;

/** The best link on the page that looks like a careers page on the same host: a path match beats a label match. */
export function careersLinkFrom(html, baseUrl) {
  const base = new URL(baseUrl);
  let byLabel = null;
  for (const match of String(html ?? '').matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, label] = match;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.host !== base.host) continue;
    if (careersPath(url.pathname)) return url.toString();
    if (!byLabel && CAREERS_LABEL.test(stripTags(label))) byLabel = url.toString();
  }
  return byLabel;
}

/**
 * Whether `/robots.txt` text allows `path` for a generic crawler. Reads the `*`
 * group only; the longest matching rule wins and Allow wins a tie. An empty or
 * missing file allows everything.
 */
export function robotsAllows(robotsText, path) {
  const rules = [];
  let applies = false;
  let inGroup = false;
  for (const raw of String(robotsText ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) { inGroup = false; continue; }
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!inGroup) applies = false;
      inGroup = true;
      if (value === '*') applies = true;
    } else if (applies && (field === 'allow' || field === 'disallow') && value) {
      rules.push({ allow: field === 'allow', prefix: value });
    }
  }
  let best = null;
  for (const rule of rules) {
    if (!path.startsWith(rule.prefix.replace(/\*.*$/, ''))) continue;
    if (!best || rule.prefix.length > best.prefix.length || (rule.prefix.length === best.prefix.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
