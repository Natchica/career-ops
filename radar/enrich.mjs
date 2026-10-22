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
  careersLinkFrom, formatHints, pageHints, parseHints, repoHints, robotsAllows, stripTags,
} from './hints.mjs';

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

/**
 * The Prospects worth probing: tier 1, untouched, with a place to look (a GitHub
 * organisation or a `portals.yml` entry), in picker order, at most `limit`.
 * A Prospect already probed (`checked:` token) is skipped unless `refresh`.
 */
export function selectForEnrichment(rows, rules, { zones = ['A', 'B'], limit = 40, keys = null, refresh = false, hasSource } = {}) {
  const wanted = new Set(zones);
  const inZone = (p) => splitCell(p.sites).some((site) => wanted.has(site.split(':').pop()?.trim()));
  const picked = rows.filter((p) => {
    if (keys) return keys.includes(p.key);
    if (p.tier !== '1' || p.spontaneous) return false;
    if (!inZone(p)) return false;
    if (!githubLogin(p) && !(hasSource && hasSource(p))) return false;
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

/** The new `hints` cell: the old cell's tokens kept except stale `checked:` and probe tokens, plus the fresh ones. */
export function mergeHints(oldCell, fresh, today, { checked }) {
  const kept = parseHints(oldCell).filter((t) => !t.startsWith('checked:') && !/^(gh|site):/.test(t));
  const all = [...kept, ...fresh];
  if (checked) all.push(`checked:${today}`);
  return formatHints(all);
}
