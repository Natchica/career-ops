/**
 * radar/enrich.mjs — read the public traces behind a Prospect and turn them into hints.
 *
 * Two places only, both public and both light:
 *   - the firm's GitHub organisation (its repositories and its website field),
 *     read through the API with the user's own token;
 *   - the firm's own careers page (a `portals.yml` careers URL, else the website
 *     from the GitHub organisation), plus the careers link on its home page.
 *
 * It reads organisations and company pages, never people. A site is read only
 * when its robots.txt allows the path; an unreachable robots.txt skips the site,
 * and a 404 for it means no rules. Requests are paced, at most 3 per site.
 * Everything stays on this machine. See radar/hints.mjs for the tokens.
 */

import { compareProspects } from './tiers.mjs';
import {
  CAREERS_HINT, NO_SITE_HINT, careersLinkFrom, formatHints, pageHints, parseHints, repoHints, robotsAllows, siteProfileHints, stripTags,
} from './hints.mjs';
import { GROUP_TAILS, needleFor, needleVariants } from './resolve.mjs';
import { fetchSitePage, guessDomains, nameMatches, pageLines, readSite } from './site.mjs';
import { foldName } from './zones.mjs';

const API = 'https://api.github.com';
const UA = 'career-ops-radar (personal job-search census, reads company careers pages only)';
const GITHUB_PACE_MS = 750;
const SITE_PACE_MS = 1000;

const splitCell = (cell) => String(cell ?? '').split(';').map((s) => s.trim()).filter(Boolean);

/** The GitHub login behind a Prospect's `#github:login` alias, or null. */
export function githubLogin(row) {
  const alias = splitCell(row.aliases).find((a) => a.startsWith('#github:'));
  return alias ? alias.slice('#github:'.length) : null;
}

/** A Prospect known only from a register: no GitHub organisation, no `portals.yml` entry. */
export function registerOnly(row) {
  const ref = String(row.portals_ref ?? '').trim();
  return !githubLogin(row) && (ref === '' || ref === '—' || ref === '-');
}

const SITE_TAILS = ['it security', 'software', 'solutions'];
const TAILS = new Set([...SITE_TAILS, ...GROUP_TAILS]);
const MAX_GUESSES = 6;

/** The base name with trailing generic words dropped one step at a time: "acme software solutions" gives "acme software", "acme". */
function trimmedBases(base) {
  const out = [];
  let tokens = base.split(' ');
  while (tokens.length > 1) {
    if (tokens.length > 2 && TAILS.has(tokens.slice(-2).join(' '))) tokens = tokens.slice(0, -2);
    else if (TAILS.has(tokens.at(-1))) tokens = tokens.slice(0, -1);
    else break;
    out.push(tokens.join(' '));
  }
  return out;
}

/**
 * Domains a register-only firm might own, at most 6: the joined spellings of the
 * name and its trimmed forms (longest first), then the hyphenated ones. A name
 * too long or too generic to guess gives none.
 */
export function siteDomains(name) {
  const primary = needleFor(name);
  if (!primary) return [];
  const bases = new Set([primary.base, ...needleVariants(name).map((n) => n.base)]);
  for (const b of [...bases]) for (const t of trimmedBases(b)) bases.add(t);
  const joined = [];
  const hyphenated = [];
  for (const base of [...bases].sort((a, b) => b.length - a.length)) {
    for (const d of guessDomains({ server: base, base })) (d.split('.')[0].includes('-') ? hyphenated : joined).push(d);
  }
  return [...new Set([...joined, ...hyphenated])].slice(0, MAX_GUESSES);
}

/**
 * The Prospects worth probing: tier 1, untouched, with a place to look (a GitHub
 * organisation or a `portals.yml` entry), in picker order, at most `limit`.
 * A Prospect already probed (`checked:` token) is skipped unless `refresh`.
 */
export function selectForEnrichment(rows, rules, { zones = ['A', 'B'], limit = 40, keys = null, refresh = false, hasSource, sites = false } = {}) {
  const wanted = new Set(zones);
  const inZone = (p) => splitCell(p.sites).some((site) => wanted.has(site.split(':').pop()?.trim()));
  const picked = rows.filter((p) => {
    if (keys) return keys.includes(p.key);
    if (p.tier !== '1' || p.spontaneous) return false;
    if (!inZone(p)) return false;
    // Site probe: the opposite pool, the register-only Prospects that nothing else gives a website.
    if (sites ? !registerOnly(p) || (hasSource && hasSource(p)) : !githubLogin(p) && !(hasSource && hasSource(p))) return false;
    return refresh || !parseHints(p.hints).some((t) => t.startsWith('checked:'));
  });
  picked.sort((a, b) => compareProspects(a, b, rules));
  return picked.slice(0, limit);
}

const isNotFound = (e) => e?.status === 404 || /\b404\b/.test(e?.message ?? '');

function alternateHost(target) {
  const copy = new URL(target.toString());
  copy.hostname = target.hostname.startsWith('www.') ? target.hostname.slice(4) : `www.${target.hostname}`;
  return copy;
}

/** robots.txt text for the first spelling of the host that answers, with the URL that answered. */
async function readRobots(target, ctx, opts) {
  let lastError = null;
  for (const candidate of [target, alternateHost(target)]) {
    try {
      return { robots: await ctx.http.fetchText(`${candidate.origin}/robots.txt`, opts), target: candidate };
    } catch (e) {
      if (isNotFound(e)) return { robots: '', target: candidate };
      lastError = e;
    }
  }
  return { robots: null, target, error: lastError };
}

async function probeSite(url, ctx) {
  let start;
  try { start = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { return { tokens: [], answered: false, note: 'bad url' }; }
  if (start.protocol !== 'https:' && start.protocol !== 'http:') return { tokens: [], answered: false, note: 'bad url' };
  const opts = { headers: { 'User-Agent': UA } };

  const found = await readRobots(start, ctx, opts);
  if (found.robots === null) return { tokens: [], answered: false, note: `robots.txt unreachable: ${start.host}` };
  const { robots, target } = found;
  await ctx.sleep(SITE_PACE_MS);
  if (!robotsAllows(robots, target.pathname || '/')) return { tokens: [], answered: false, note: `robots.txt disallows ${target.host}` };

  let html;
  try {
    html = await ctx.http.fetchText(target.toString(), opts);
  } catch (e) {
    return { tokens: [], answered: false, note: `${target.host}: ${e?.message ?? e}` };
  }
  const tokens = new Set(pageHints(stripTags(html)));
  const link = careersLinkFrom(html, target.toString());
  if (link && link !== target.toString() && robotsAllows(robots, new URL(link).pathname)) {
    await ctx.sleep(SITE_PACE_MS);
    try {
      const careers = await ctx.http.fetchText(link, opts);
      for (const t of pageHints(stripTags(careers))) tokens.add(t);
    } catch { /* the home page already answered */ }
  }
  return { tokens: [...tokens], answered: true, note: '' };
}

/**
 * Probe one Prospect. Never throws: a failing source is reported in `notes`.
 * `answered` is true when at least one source replied, so a network outage does
 * not mark the Prospect as checked.
 *
 * @param {object} row  A registry row.
 * @param {{http: {fetchJson: Function, fetchText: Function}, token?: string, sleep: Function, now?: Date, careersUrlFor?: Function}} ctx
 * @returns {Promise<{tokens: string[], answered: boolean, notes: string[]}>}
 */
export async function enrichRow(row, ctx) {
  const tokens = new Set();
  const notes = [];
  let answered = false;
  const sites = [];

  const careers = ctx.careersUrlFor?.(row);
  if (careers) sites.push(careers);

  const login = githubLogin(row);
  if (login && ctx.token) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'career-ops-radar', Authorization: `Bearer ${ctx.token}` };
    try {
      const org = await ctx.http.fetchJson(`${API}/orgs/${encodeURIComponent(login)}`, { headers });
      answered = true;
      if (org?.blog) sites.push(org.blog);
      await ctx.sleep(GITHUB_PACE_MS);
      const repos = await ctx.http.fetchJson(`${API}/orgs/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&type=public`, { headers });
      for (const t of repoHints(Array.isArray(repos) ? repos : [], ctx.now ?? new Date())) tokens.add(t);
      await ctx.sleep(GITHUB_PACE_MS);
    } catch (e) {
      notes.push(`github ${login}: ${e?.message ?? e}`);
    }
  } else if (login) {
    notes.push('github: no token, skipped');
  }

  const seen = new Set();
  for (const site of sites.slice(0, 2)) {
    let host;
    try { host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).host; } catch { notes.push(`bad url: ${site}`); continue; }
    if (seen.has(host)) continue;
    seen.add(host);
    const result = await probeSite(site, ctx);
    if (result.answered) answered = true;
    if (result.note) notes.push(result.note);
    for (const t of result.tokens) tokens.add(t);
  }
  return { tokens: [...tokens], answered, notes };
}

/**
 * A guessed domain is this Prospect's own site when the legal name or the title
 * on it carries the registered name, or when the page text carries the full name
 * as whole words together with one of the Prospect's registered places. A
 * namesake that shares only a part of the name never verifies.
 */
function verifiesSite(read, needle, places) {
  if (read.pages === 0) return false;
  if (nameMatches(read.legalName, [needle]) || nameMatches(read.title, [needle])) return true;
  const text = ` ${foldName(read.texts.map((t) => pageLines(t.html).join(' ')).join(' '))} `;
  return text.includes(` ${needle.base} `) && places.some((place) => text.includes(` ${place} `));
}

/**
 * Probe one register-only Prospect's own website (the Site probe). Guessed
 * domains are read in order with `readSite` (robots.txt, 1 s pace, at most 2
 * pages); the first verified one is kept as `web:{domain}` with the hint tokens
 * from its pages, and its careers page is read as the second page when the
 * Impressum was not needed. No verified domain gives `site:none`. A domain that
 * does not exist counts as an answer; a network outage does not, so nothing is
 * marked as checked while offline. Never throws.
 *
 * @param {object} row  A registry row.
 * @param {{http: {fetchText: Function}, sleep: Function, table: object}} ctx
 * @returns {Promise<{tokens: string[], answered: boolean, notes: string[]}>}
 */
export async function siteProbeRow(row, ctx) {
  const needle = needleFor(row.name);
  const domains = siteDomains(row.name);
  const notes = [];
  if (!needle || domains.length === 0) return { tokens: [NO_SITE_HINT], answered: true, notes };
  const places = splitCell(row.sites).map((s) => foldName(s.slice(0, s.lastIndexOf(':')))).filter(Boolean);

  let reached = false;
  let forbidden = false;
  for (const domain of domains) {
    const read = await readSite(domain, ctx, { keepText: true });
    if (typeof read.robots === 'string' || read.nxdomain) reached = true;
    if (read.note.startsWith('robots.txt disallows')) forbidden = true;
    if (!verifiesSite(read, needle, places)) {
      notes.push(`${domain}: ${read.note || 'name does not match'}`);
      continue;
    }
    const tokens = new Set([`web:${domain}`]);
    const texts = read.texts.map((t) => stripTags(t.html));
    const home = read.texts[0];
    const link = careersLinkFrom(home.html, home.url);
    if (link) tokens.add(CAREERS_HINT);
    if (link && link !== home.url && read.pages < 2 && robotsAllows(read.robots, new URL(link).pathname)) {
      try {
        texts.push(stripTags((await fetchSitePage(link, domain, ctx)).text));
      } catch (e) {
        notes.push(`careers ${link}: ${e?.message ?? e}`);
      }
    }
    for (const text of texts) for (const t of [...pageHints(text), ...siteProfileHints(text)]) tokens.add(t);
    return { tokens: [...tokens], answered: true, notes };
  }
  // A guess whose robots.txt forbids reading is a real site we may not read: neutral, never "no site found".
  if (forbidden) return { tokens: [], answered: true, notes };
  return reached ? { tokens: [NO_SITE_HINT], answered: true, notes } : { tokens: [], answered: false, notes };
}

/** The new `hints` cell: the old cell's tokens kept except stale `checked:` and probe tokens, plus the fresh ones. */
export function mergeHints(oldCell, fresh, today, { checked }) {
  const kept = parseHints(oldCell).filter((t) => !t.startsWith('checked:') && !/^(gh|site|web):/.test(t));
  const all = [...kept, ...fresh];
  if (checked) all.push(`checked:${today}`);
  return formatHints(all);
}
