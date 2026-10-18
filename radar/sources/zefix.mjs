/**
 * radar/sources/zefix.mjs — Swiss firms whose registered purpose is software.
 *
 * Zefix, the central commercial-register index, holds the name, legal form,
 * seat, address and statutory purpose of every active Swiss legal entity. It has
 * no activity code and no employee count, so a census of it would add 150,000
 * or more entities that say nothing about who employs developers. This source
 * keeps only those whose purpose text says they build software or sell IT
 * services: a firm the job boards and GitHub never name, with a technical
 * signal built in.
 *
 * It reads the open-data copy on LINDAS (the Federal Archives' linked-data
 * service), the channel the Federal Office of Justice points to for bulk data,
 * not the Zefix REST API, which is for individual lookups. LINDAS publishes
 * fair-use rules for automated queries ("How to Use LINDAS Efficiently and
 * Responsibly", 2026-08-04) and this source follows them: LIMIT and OFFSET with
 * a stable ORDER BY, filters inside the query, only the variables it needs, one
 * request at a time at least 3 seconds apart, backoff on failure, an identifying
 * User-Agent, and results cached. No regular expressions run on the server.
 * Data licence: OGD, attribution required. Source: Zefix, Eidg. Amt fuer das
 * Handelsregister, via LINDAS.
 *
 * The purpose is a statutory aim, not a record of what the firm does, and it
 * can list software among twenty other things. So the text is graded locally:
 * only a "strong" purpose (building software, IT services) becomes a record and
 * earns the software signal. A "weak" mention (trading in hardware and software,
 * holding shares in software firms) is counted in the log and dropped. The text
 * itself is never stored, and sole proprietorships are skipped because their
 * name is a person's.
 */

import { fetchJsonWithRetry } from '../../providers/_http.mjs';

const ENDPOINT = 'https://lindas.admin.ch/query';
const GRAPH = 'https://lindas.admin.ch/foj/zefix';
const USER_AGENT = 'career-ops-radar/1.0 (personal job-search tool, local use, throttled)';
const PAGE = 500;
const BATCH = 25;
const PACE_MS = 3000;
const SOLE_PROPRIETORSHIP = 'https://ld.admin.ch/ech/97/legalforms/0101';

/** Stems the server filters on: a superset of what the local grading needs. */
const SERVER_STEMS = ['software', 'informatik', 'programmier', 'logiciel', 'informatique', 'it-dienst', 'it-beratung', 'it consulting'];

const STRONG = [
  /software-?entwicklung/,
  /entwick\w*[^.]{0,60}software/,
  /software[- ]?(consulting|beratung|dienstleistung|engineering|l[oö]sung|produkt|plattform|applikation)/,
  /informatik-?dienstleistung|it-?dienstleistung|it-?beratung|it[- ]consulting|informatik-?beratung|beratung[^.]{0,30}informatik/,
  /programmier/,
  /d[eé]veloppement[^.]{0,40}logiciel|logiciel[^.]{0,40}d[eé]velopp|services? informatiques?|conseil en informatique|prestations? informatiques?/,
  /software development|software engineering|develop\w*[^.]{0,40}software/,
];
const WEAK = /software|informatik|programmier|logiciel|informatique|it-dienst|it-beratung/;

/** How strongly a purpose text says "builds software or sells IT services": strong, weak or null. */
export function purposeStrength(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return null;
  if (STRONG.some((re) => re.test(t))) return 'strong';
  return WEAK.test(t) ? 'weak' : null;
}

/** The four-digit Swiss postcodes of the zones in play, from the zone table. */
export function chPostcodes(table, zones) {
  const seen = new Set();
  for (const r of table.ranges) {
    if (r.place.country !== 'CH' || !r.place.zone || r.digits !== 4) continue;
    if (zones && !zones.includes(r.place.zone)) continue;
    for (let n = r.from; n <= r.to; n++) seen.add(String(n).padStart(4, '0'));
  }
  return [...seen].sort();
}

/** Split a list into groups of at most `size`. */
export function batches(codes, size = BATCH) {
  const out = [];
  for (let i = 0; i < codes.length; i += size) out.push(codes.slice(i, i + size));
  return out;
}

/** The SPARQL for one batch of postcodes and one page. Only plain four-digit codes may reach it. */
export function buildQuery(postcodes, offset) {
  if (!postcodes.length || postcodes.some((cp) => !/^\d{4}$/.test(cp))) {
    throw new Error('zefix: a query needs one or more four-digit postcodes');
  }
  const values = postcodes.map((cp) => `"${cp}"`).join(' ');
  const filter = SERVER_STEMS.map((stem) => `CONTAINS(?dl, "${stem}")`).join(' || ');
  return `PREFIX admin: <https://schema.ld.admin.ch/>
PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?form ?pc ?city ?uid ?d
FROM <${GRAPH}>
WHERE {
  VALUES ?pc { ${values} }
  ?s a admin:ZefixOrganisation ;
     schema:legalName ?name ;
     schema:additionalType ?form ;
     schema:description ?d ;
     schema:identifier ?uid ;
     schema:address ?a .
  ?a schema:postalCode ?pc ;
     schema:addressLocality ?city .
  FILTER(CONTAINS(STR(?uid), "/UID/"))
  BIND(LCASE(STR(?d)) AS ?dl)
  FILTER(${filter})
}
ORDER BY ?s
LIMIT ${PAGE}
OFFSET ${offset}`;
}

const value = (binding, key) => binding?.[key]?.value ?? '';

export default {
  id: 'zefix',
  family: 'register',
  auth: { kind: 'none', vars: [] },

  async *fetch(ctx) {
    const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let requests = 0;

    const ask = async (query) => {
      if (requests++ > 0) await sleep(PACE_MS);
      return fetchJsonWithRetry(ctx.http, ENDPOINT, {
        method: 'POST',
        body: new URLSearchParams({ query }).toString(),
        headers: {
          Accept: 'application/sparql-results+json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
      });
    };

    const postcodes = ctx.postcodes ?? chPostcodes(ctx.table, ctx.zones ?? null);
    const groups = batches(postcodes);
    const seen = new Set();

    for (const [index, group] of groups.entries()) {
      const unit = `${group[0]}-${group.at(-1)}`;
      const done = () => ctx.log?.(`zefix: batch ${index + 1}/${groups.length} done`);
      const cached = ctx.cache?.get(unit);
      if (cached) {
        yield* cached;
        done();
        continue;
      }

      const records = [];
      let weak = 0;
      for (let offset = 0; ; offset += PAGE) {
        const answer = await ask(buildQuery(group, offset));
        const rows = answer?.results?.bindings ?? [];
        for (const row of rows) {
          if (value(row, 'form') === SOLE_PROPRIETORSHIP) continue;
          const uid = value(row, 'uid').split('/UID/')[1];
          const name = value(row, 'name').trim();
          if (!uid || !name || seen.has(uid)) continue;
          seen.add(uid);
          const strength = purposeStrength(value(row, 'd'));
          if (strength === 'weak') { weak++; continue; }
          if (strength !== 'strong') continue;
          records.push({
            name,
            legalName: name,
            entityId: `uid:${uid}`,
            place: value(row, 'city'),
            postcode: value(row, 'pc'),
            country: 'CH',
            sector: 'zefix-purpose:software',
            signalTokens: ['zefix:software'],
            sizeBand: '?',
            sourceId: 'zefix',
            evidence: `zefix:${uid}`,
          });
        }
        if (rows.length < PAGE) break;
      }
      if (weak > 0) ctx.log?.(`zefix: skipped ${weak} weak purpose match(es) in ${unit}`);
      ctx.cache?.set(unit, records);
      yield* records;
      done();
    }
  },
};
