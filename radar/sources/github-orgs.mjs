/**
 * radar/sources/github-orgs.mjs — engineering-heavy firms with a place in a zone.
 *
 * Vetted 2026-10-18: api.github.com serves no robots.txt (404), and the
 * Acceptable Use Policies forbid spam and selling personal information to
 * recruiters. This source stays inside that: it reads ORGANISATIONS only
 * (`type:org`), keeps their public login, display name, location and website,
 * and never reads users or emails. Everything stays on this machine.
 *
 * One search per zone place name. The token is optional:
 *   - with GITHUB_PERSONAL_ACCESS_TOKEN each organisation is read for its own
 *     location, which is zoned precisely, at 30 searches a minute;
 *   - without it the organisation is placed at the place that was searched, at
 *     10 searches a minute, and names that are also a place outside the zones
 *     (Freiburg, Baden) are skipped, since nothing can tell them apart.
 *
 * The search API serves at most 1000 results per query; a bigger query is read
 * up to that cut-off and the cut-off is logged. The token is only ever sent in
 * an Authorization header: it is never logged, cached or put in a record.
 */

import { fetchJsonWithRetry, parseRetryAfterMs } from '../../providers/_http.mjs';
import { foldName } from '../zones.mjs';

const API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 10;
const SEARCH_PACE_ANON_MS = 6000;
const SEARCH_PACE_AUTH_MS = 2000;
const DETAIL_PACE_MS = 750;
const RATE_LIMIT_FALLBACK_MS = 60_000;

/**
 * Place names to search, from the zone table. Without a token, a name shared
 * with another place (also across the zone border) is skipped.
 */
export function searchNames(table, zones, { authenticated }) {
  const seen = new Set();
  const names = [];
  for (const place of table.places) {
    if (!place.zone || (zones && !zones.includes(place.zone))) continue;
    for (const label of [place.name, ...place.aliases]) {
      const key = foldName(label);
      if (!key || seen.has(key)) continue;
      if (!authenticated && (table.byName.get(key) ?? []).length > 1) continue;
      seen.add(key);
      names.push(label);
    }
  }
  return names;
}

export default {
  id: 'github-orgs',
  family: 'github',
  auth: { kind: 'optional-env', vars: ['GITHUB_PERSONAL_ACCESS_TOKEN'] },

  async *fetch(ctx) {
    const token = ctx.env?.GITHUB_PERSONAL_ACCESS_TOKEN || '';
    const authenticated = token.length > 0;
    const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'career-ops-radar',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    };
    let requests = 0;

    const get = async (url, kind) => {
      if (requests++ > 0) await sleep(kind === 'search' ? (authenticated ? SEARCH_PACE_AUTH_MS : SEARCH_PACE_ANON_MS) : DETAIL_PACE_MS);
      for (let attempt = 0; ; attempt++) {
        try {
          return await fetchJsonWithRetry(ctx.http, url, { headers });
        } catch (e) {
          if (e?.status !== 403 && e?.status !== 429) throw e;
          if (attempt > 0) throw new Error(`GitHub rate limit: ${e.message}`);
          await sleep(parseRetryAfterMs(e.retryAfter) ?? RATE_LIMIT_FALLBACK_MS);
        }
      }
    };

    async function* sweep(name) {
      const q = encodeURIComponent(`type:org location:"${name}"`);
      let total = Infinity;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await get(`${API}/search/users?q=${q}&per_page=${PER_PAGE}&page=${page}`, 'search');
        if (page === 1 && (body.total_count ?? 0) > MAX_PAGES * PER_PAGE) {
          ctx.log?.(`github-orgs: "${name}" matches ${body.total_count} organisations; reading the first ${MAX_PAGES * PER_PAGE}`);
        }
        total = body.total_count ?? 0;
        for (const found of body.items ?? []) {
          const login = found.login;
          if (!login) continue;
          if (!authenticated) {
            yield { name: login, place: name, url: found.html_url, entityId: `github:${login}`, sourceId: 'github-orgs', evidence: `github:${login}` };
            continue;
          }
          let org;
          try {
            org = await get(`${API}/orgs/${encodeURIComponent(login)}`, 'detail');
          } catch (e) {
            if (/rate limit/i.test(e?.message ?? '')) throw e;
            ctx.log?.(`github-orgs: skipped ${login}: ${e?.message ?? e}`);
            continue;
          }
          yield {
            name: (org.name || login).trim(),
            locationText: org.location || name,
            url: org.blog || org.html_url || found.html_url,
            entityId: `github:${login}`,
            sourceId: 'github-orgs',
            evidence: `github:${login}`,
          };
        }
        if (page * PER_PAGE >= total) break;
      }
    }

    const names = ctx.searchNames ?? searchNames(ctx.table, ctx.zones ?? null, { authenticated });
    for (const name of names) {
      const cached = ctx.cache?.get(name);
      if (cached) {
        yield* cached;
        continue;
      }
      const records = [];
      for await (const record of sweep(name)) {
        records.push(record);
        yield record;
      }
      ctx.cache?.set(name, records);
    }
  },
};
