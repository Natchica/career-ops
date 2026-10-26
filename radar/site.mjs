/**
 * radar/site.mjs — place a company from its own website when the registers
 * could not: read the Impressum or contact page for a legal name and a postcode
 * and place that falls in a zone. Zero model. Pages are untrusted data: only a
 * legal name, a title, a postcode and a place are kept, with `;` and `#` removed.
 *
 * Courtesy: robots.txt honoured, one identifying User-Agent, at most 2 pages per
 * domain, 1 s between requests, 10 s timeout, same-site redirects only.
 */

import { baseKey } from './identity.mjs';
import { resolveZone } from './zones.mjs';
import { robotsAllows } from './hints.mjs';
import { GENERIC_NAMES, formatCandidates } from './resolve.mjs';
import { fetchTextWithRetry } from '../providers/_http.mjs';

export const SITE_USER_AGENT = 'career-ops-radar (personal job-search census, reads company pages only)';
export const SITE_PACE_MS = 1000;
export const SITE_TIMEOUT_MS = 10_000;
export const MAX_HOPS = 3;
export const WEBMAIL = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'icloud.com', 'gmx.ch', 'gmx.net', 'gmx.de',
  'bluewin.ch', 'protonmail.com', 'proton.me', 'web.de', 't-online.de', 'orange.fr', 'free.fr', 'wanadoo.fr', 'laposte.net',
]);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const NAMED = { uuml: 'ü', auml: 'ä', ouml: 'ö', Uuml: 'Ü', Auml: 'Ä', Ouml: 'Ö', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', szlig: 'ß', amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(Number(d), m))
    .replace(/&([A-Za-z]+);/g, (m, n) => NAMED[n] ?? m);
}

function safeChar(code, fallback) {
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

const stripMarkup = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Visible text split into lines at block boundaries. */
export function pageLines(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|td|th|dd|dt|address|section|footer|header|span|a)>/gi, '\n')
    .split('\n')
    .map(stripMarkup)
    .filter(Boolean);
}

export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  if (!m) return '';
  return stripMarkup(m[1]).split(/ \| |: | - | – /)[0].trim().slice(0, 80);
}

export function countryHint(domain) {
  const tld = String(domain ?? '').toLowerCase().split('.').pop();
  return { ch: 'CH', fr: 'FR', de: 'DE' }[tld] ?? null;
}

/** Domains a company with this needle might own; none for a long or generic name. */
export function guessDomains(needle) {
  if (!needle || GENERIC_NAMES.has(needle.base)) return [];
  const tokens = needle.base.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3 || tokens.some((t) => !/^[a-z0-9]+$/.test(t))) return [];
  const joined = tokens.join('');
  const hyphen = tokens.join('-');
  return [...new Set([`${joined}.ch`, `${joined}.com`, `${hyphen}.ch`, `${hyphen}.com`])].filter((d) => d.split('.')[0].length <= 63);
}

const registrable = (host) => String(host).toLowerCase().replace(/^www\./, '');
const sameSite = (host, domain) => {
  const h = registrable(host);
  const d = registrable(domain);
  return h === d || h.endsWith(`.${d}`);
};

const LINK_CLASSES = [
  /(?<!\p{L})impressum(?!\p{L})/iu,
  /(?<!\p{L})(?:kontakt|contact)(?!\p{L})/iu,
  /(?<!\p{L})mentions?[\s-]+l[ée]gales?(?!\p{L})/iu,
  /(?<!\p{L})about(?!\p{L})|(?<!\p{L})(?:ü|ue)ber[\s-]uns(?!\p{L})/iu,
  /(?<!\p{L})legal(?!\p{L})/iu,
];

/** The best Impressum-like link on the page that stays on the same site, or null. */
export function impressumLink(html, baseUrl) {
  const base = new URL(baseUrl);
  let best = null;
  for (const m of String(html ?? '').matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(m[1], base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url.hostname, base.hostname)) continue;
    const label = stripMarkup(m[2]);
    const path = decodeURIComponentSafe(url.pathname).replace(/[-_/.]/g, ' ');
    const rank = LINK_CLASSES.findIndex((re) => re.test(label) || re.test(path));
    if (rank !== -1 && (best === null || rank < best.rank)) best = { rank, href: url.toString() };
  }
  return best?.href ?? null;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const ADDRESS = /(?:^|[^\d\p{L}])(?:(?:CH|F|D)-)?(\d{4,5})\s+(\p{Lu}[\p{L}'’.-]*(?:[ -]\p{Lu}[\p{L}'’.-]*){0,2})/gu;

/**
 * Postcode and place pairs in the lines that fall in a zone. A pair counts only
 * when the postcode and the place name agree on the same place: the postcode
 * alone would read `4000 Mitarbeitende` as Basel.
 */
export function addressPairs(lines, { table, country = null }) {
  const out = [];
  const seen = new Set();
  lines.forEach((line, index) => {
    for (const m of line.matchAll(ADDRESS)) {
      const postcode = m[1];
      const words = m[2].split(' ');
      for (let n = Math.min(3, words.length); n >= 1; n--) {
        const place = words.slice(0, n).join(' ').replace(/[.,;]+$/, '');
        const byCode = resolveZone(table, { postcode, place, country: country ?? undefined });
        if (!byCode.zone) continue;
        const byName = resolveZone(table, { place, country: byCode.country });
        if (byName.zone !== byCode.zone || byName.place !== byCode.place) continue;
        const id = `${postcode}|${place}`;
        if (!seen.has(id)) {
          seen.add(id);
          out.push({ postcode, place, zone: byCode.zone, country: byCode.country, line: index });
        }
        break;
      }
    }
  });
  return out;
}

const LEGAL_TOKEN = /(?:^|[\s,])(AG|GmbH|SA|Sàrl|SARL|SAS|Ltd|Genossenschaft|Stiftung)(?=$|[\s,.;)])/u;
const LEAD = /^(?:©|\(c\)|copyright)?[\s©]*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?[\s,.:-]*/iu;

/** The legal name on the line nearest to `index`, or ''. */
export function legalNameNear(lines, index) {
  const order = [0];
  for (let d = 1; d <= 8; d++) order.push(-d, d);
  for (const d of order) {
    const line = lines[index + d];
    if (line === undefined) continue;
    const m = LEGAL_TOKEN.exec(line);
    if (!m) continue;
    const end = m.index + m[0].length;
    let name = line.slice(0, end).replace(/^.*:\s*/, '').replace(LEAD, '').replace(/^[\s,.;-]+/, '').trim();
    name = name.replace(/^(?:©|\(c\)|copyright)\s*/iu, '').replace(LEAD, '').trim();
    if (name.length >= 2 && name.length <= 80) return name;
  }
  return '';
}

/**
 * One polite page fetch: pace, identifying User-Agent, timeout, and same-site
 * redirects only (at most MAX_HOPS). Throws on a fetch failure.
 *
 * @returns {Promise<{text:string, url:URL}>}
 */
export async function fetchSitePage(start, domain, ctx, { retries = 0 } = {}) {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await ctx.sleep(SITE_PACE_MS);
    try {
      const text = await fetchTextWithRetry(ctx.http, url.toString(), {
        headers: { 'User-Agent': SITE_USER_AGENT }, timeoutMs: SITE_TIMEOUT_MS, redirect: 'manual',
      }, { retries });
      return { text, url };
    } catch (e) {
      if (typeof e?.status === 'number' && e.status >= 300 && e.status < 400 && e.location) {
        const next = new URL(e.location, url);
        if (!/^https?:$/.test(next.protocol) || !sameSite(next.hostname, domain)) throw new Error(`redirects off-site to ${next.host}`);
        url = next;
        continue;
      }
      throw e;
    }
  }
  throw new Error('too many redirects');
}

/**
 * Read a domain: robots.txt, the home page, then the best Impressum-like page.
 * Never throws for a fetch failure; the failure comes back as `note`.
 * With `keepText` the result also carries `texts` (the pages read, home first),
 * `robots` (the robots.txt text, or null when unreachable) and `nxdomain` (the
 * name does not exist, as opposed to a network outage); callers that read the
 * Candiboost resolution never ask for it.
 *
 * @returns {Promise<{domain:string, legalName:string, title:string, pair:object|null, pages:number, note:string}>}
 */
export async function readSite(domain, ctx, { retries = 0, keepText = false } = {}) {
  const result = { domain, legalName: '', title: '', pair: null, pages: 0, note: '' };
  if (keepText) Object.assign(result, { texts: [], robots: null, nxdomain: false });
  const get = (start) => fetchSitePage(start, domain, ctx, { retries });

  let robots = null;
  let origin = '';
  const hosts = domain.startsWith('www.') ? [domain, domain.slice(4)] : [domain, `www.${domain}`];
  for (const host of hosts) {
    try {
      const r = await get(`https://${host}/robots.txt`);
      robots = r.text;
      origin = r.url.origin;
      break;
    } catch (e) {
      if (e?.status === 404 || e?.status === 410) { robots = ''; origin = `https://${host}`; break; }
      if (keepText && e?.cause?.code === 'ENOTFOUND') result.nxdomain = true;
    }
  }
  if (keepText) result.robots = robots;
  if (robots === null) return { ...result, note: 'robots.txt unreachable' };
  if (!robotsAllows(robots, '/')) return { ...result, note: 'robots.txt disallows /' };

  let home;
  try {
    home = await get(`${origin}/`);
  } catch (e) {
    return { ...result, note: String(e?.message ?? e) };
  }
  result.pages = 1;
  result.title = titleOf(home.text);
  const pages = [{ html: home.text, lines: pageLines(home.text) }];
  if (keepText) result.texts.push({ url: home.url.toString(), html: home.text });

  const link = impressumLink(home.text, home.url.toString());
  if (link && link !== home.url.toString() && robotsAllows(robots, new URL(link).pathname)) {
    try {
      const contact = await get(link);
      result.pages = 2;
      pages.unshift({ html: contact.text, lines: pageLines(contact.text) });
      if (keepText) result.texts.push({ url: contact.url.toString(), html: contact.text });
    } catch { /* the home page already answered */ }
  }

  const country = countryHint(domain);
  for (const page of pages) {
    const [pair] = addressPairs(page.lines, { table: ctx.table, country });
    if (!pair) continue;
    result.pair = pair;
    result.legalName = legalNameNear(page.lines, pair.line);
    break;
  }
  if (!result.pair) result.note = 'no in-zone address';
  return result;
}

const clean = (s) => String(s ?? '').replace(/[;#]/g, ',').replace(/\s+/g, ' ').trim().slice(0, 80);

export function nameMatches(name, needles) {
  const key = baseKey(name);
  return needles.some((n) => n && (key === n.base || key.startsWith(`${n.base} `)));
}

/**
 * Place a spelling the registers left unresolved. A known company domain is
 * trusted; otherwise up to 4 guessed domains are read, and a guess counts only
 * when the page's legal name or title carries the spelling.
 *
 * @returns {Promise<object|null>} a patch for the resolution row, or null when there is nothing to read
 */
export async function siteResolve(spelling, { domain, needle, variants = [] }, ctx) {
  const known = String(domain ?? '').trim().toLowerCase();
  const trusted = HOSTNAME.test(known) && !WEBMAIL.has(known);
  const targets = trusted ? [known] : guessDomains(needle);
  if (targets.length === 0) return null;

  let firstNote = null;
  for (const d of targets) {
    const read = await readSite(d, ctx, { retries: trusted ? 1 : 0 });
    ctx.log?.(`candiboost: site ${d}: ${read.pair ? `${read.pair.postcode} ${read.pair.place}` : read.note}`);
    if (!read.pair) {
      if (firstNote === null && read.note && (read.pages > 0 || read.note.startsWith('robots.txt disallows'))) firstNote = `site:${d}: ${read.note}`;
      continue;
    }
    const name = trusted ? read.legalName : (read.legalName || read.title);
    if (!trusted && !nameMatches(name, [needle, ...variants])) {
      firstNote ??= `site:${d}: name does not match`;
      continue;
    }
    const legal = clean(name);
    return {
      verdict: 'site',
      country: read.pair.country,
      legal_name: legal,
      entity_id: `site:${d}`,
      place: clean(read.pair.place),
      postcode: read.pair.postcode,
      size_band: '?',
      candidates: formatCandidates([{ legalName: legal || spelling, entityId: `site:${d}`, sites: [{ place: clean(read.pair.place), postcode: read.pair.postcode }] }]),
    };
  }
  return { verdict: 'unresolved', candidates: firstNote ?? 'no site' };
}
