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
 *   site:software          the site describes building or selling software
 *   site:careers           the home page links to a careers or jobs page
 *   site:placement         the site offers staffing, temporary placement or body leasing
 *   site:none              a Site probe tried every guessed domain and none verified
 *   web:{domain}           the verified website of a register-only Prospect (Site probe)
 *   checked:YYYY-MM-DD     the Prospect was probed on that day (never scored)
 *
 * `hintScore` runs from -2 to 4: +1 each for open applications, a stack trace,
 * software and careers, -1 for no site, -2 for placement. An unprobed Prospect
 * scores 0, so the order inside a zone is confirmed good, unprobed, no site.
 * Hints only order Prospects inside one zone and country group, so a Prospect
 * with a better zone is never overtaken by a hint.
 */

const DAY_MS = 86_400_000;
const RECENT_DAYS = 730;

export const STACK_HINTS = Object.freeze(['gh:java', 'gh:rust', 'site:java', 'site:rust']);
export const OPEN_APPS_HINT = 'site:open-apps';
export const SOFTWARE_HINT = 'site:software';
export const CAREERS_HINT = 'site:careers';
export const PLACEMENT_HINT = 'site:placement';
export const NO_SITE_HINT = 'site:none';

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

/** -2 to 4: see the header. */
export function hintScore(row) {
  const tokens = parseHints(row?.hints);
  const has = (t) => tokens.includes(t);
  const stack = tokens.some((t) => STACK_HINTS.includes(t)) ? 1 : 0;
  return (has(OPEN_APPS_HINT) ? 1 : 0) + stack + (has(SOFTWARE_HINT) ? 1 : 0) + (has(CAREERS_HINT) ? 1 : 0)
    - (has(NO_SITE_HINT) ? 1 : 0) - (has(PLACEMENT_HINT) ? 2 : 0);
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

// Strong phrases only: a bare "software" appears on every IT-adjacent page.
const SOFTWARE = new RegExp([
  'software[-\\s]?(?:entwicklung|development|engineering|l[oö]sungen?|solutions?|plattform|platform|produkt|product)',
  '(?:app|web|backend|individual)[-\\s]?(?:software[-\\s]?)?entwicklung',
  'entwicklung\\s+(?:von|individueller|massgeschneiderter)\\s+software',
  '(?:build|develop|ship)(?:s|ing)?\\s+(?:custom\\s+|our\\s+own\\s+)?software',
  'custom\\s+software', 'individualsoftware', 'saas', 'logiciels?\\s+(?:de|sur\\s+mesure)', '[ée]diteur\\s+de\\s+logiciels?',
].join('|'), 'iu');
// Service phrases for staffing and body leasing, not a bare "recruit": a firm hiring its own engineers is no placement firm.
const PLACEMENT = new RegExp([
  'personalverleih', 'personalvermittlung', 'arbeitnehmer[üu]berlassung', 'tempor[äa]rstellen', 'temporary\\s+staffing',
  'staffing\\s+services', 'body[-\\s]?leasing', 'travail\\s+temporaire', 'placement\\s+de\\s+personnel', "agence\\s+d['’]int[ée]rim",
  'recruitment\\s+services',
].join('|'), 'iu');

/** Site probe tokens from the visible text of a home or second page: software, placement. */
export function siteProfileHints(text) {
  const t = String(text ?? '');
  const out = [];
  if (SOFTWARE.test(t)) out.push(SOFTWARE_HINT);
  if (PLACEMENT.test(t.replace(/software\s+f[üu]r\s+personalvermittler\w*/giu, ' '))) out.push(PLACEMENT_HINT);
  return out;
}

/** The domain after `web:` in a hints cell, or null. */
export function webDomain(cell) {
  const token = parseHints(cell).find((t) => t.startsWith('web:'));
  return token ? token.slice('web:'.length) || null : null;
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
