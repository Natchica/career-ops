/**
 * radar/resolve.mjs — resolve a Candiboost company spelling to a register entity
 * by name: Zefix through LINDAS (Switzerland) and recherche-entreprises (France).
 *
 * No file I/O. Register answers are untrusted data: only legal names, ids,
 * places, postcodes, a purpose grade, an activity code and a size band are kept.
 * Purpose text and managers' names are never stored.
 */

import { foldName, resolveZone } from './zones.mjs';
import { baseKey, LEGAL_FORMS } from './identity.mjs';
import { GRAPH, SOLE_PROPRIETORSHIP, IN_LIQUIDATION, purposeStrength } from './sources/zefix.mjs';
import { sizeBand } from './sources/sirene.mjs';

export const NEEDLES_PER_QUERY = 10;
export const ZEFIX_PACE_MS = 3000;
export const SIRENE_PACE_MS = 340;
export const LINDAS_TIMEOUT_MS = 120_000;
export const MAX_PAGES = 20;
export const GENERIC_NAMES = new Set(['freelance web development', 'selfemployement', 'data services']);

const PAGE = 500;
const MAX_NEEDLE = 80;
const SAFE_NEEDLE = /^[\p{L}\p{N}][\p{L}\p{N} &'’.+-]*$/u;
const LEGAL_FORM_STRINGS = new Set(LEGAL_FORMS.map((f) => f.join(' ')));
const MAX_LISTED = 20;

/**
 * The lookup needle for a Candiboost spelling: `server` keeps accents, lower
 * case, for the register's LCASE; `base` is the folded key the entity names are
 * compared on. `null` when the spelling cannot be looked up safely or usefully.
 *
 * @param {string} spelling
 * @returns {{server:string, base:string}|null}
 */
export function needleFor(spelling) {
  const segment = String(spelling ?? '').split(/,| - | – | \| /)[0].replace(/\([^)]*\)/g, ' ').trim();
  const base = baseKey(segment);
  if (base.length < 3 || GENERIC_NAMES.has(base)) return null;
  const tokens = segment.toLowerCase().normalize('NFC').split(/\s+/).filter(Boolean);
  while (tokens.length > 1) {
    const folded = foldName(tokens.at(-1));
    if (folded === '' || LEGAL_FORM_STRINGS.has(folded)) tokens.pop();
    else break;
  }
  let server = tokens.join(' ');
  if (foldName(server) !== base) server = base;
  if (server.length > MAX_NEEDLE || !SAFE_NEEDLE.test(server)) return null;
  return { server, base };
}

/**
 * The by-name SPARQL query: entities whose legal name starts with one of the
 * needles. Bounded, ordered and regex-free, as the fair-use rules ask.
 *
 * @param {string[]} needles `server` values, at most NEEDLES_PER_QUERY
 * @param {number} offset
 */
export function buildNameQuery(needles, offset) {
  if (!Array.isArray(needles) || needles.length === 0) throw new Error('buildNameQuery: no needles');
  if (needles.length > NEEDLES_PER_QUERY) throw new Error(`buildNameQuery: more than ${NEEDLES_PER_QUERY} needles`);
  for (const n of needles) {
    if (typeof n !== 'string' || n.length > MAX_NEEDLE || !SAFE_NEEDLE.test(n)) {
      throw new Error(`buildNameQuery: unsafe needle ${JSON.stringify(n)}`);
    }
  }
  const values = needles.map((n) => `"${n}"`).join(' ');
  return `PREFIX admin: <https://schema.ld.admin.ch/>
PREFIX schema: <http://schema.org/>
SELECT ?name ?form ?pc ?city ?uid ?d ?needle
FROM <${GRAPH}>
WHERE {
  VALUES ?needle { ${values} }
  ?s a admin:ZefixOrganisation ;
     schema:legalName ?name ;
     schema:additionalType ?form ;
     schema:description ?d ;
     schema:identifier ?uid ;
     schema:address ?a .
  ?a schema:postalCode ?pc ;
     schema:addressLocality ?city .
  FILTER(CONTAINS(STR(?uid), "/UID/"))
  FILTER(STRSTARTS(LCASE(STR(?name)), ?needle))
}
ORDER BY ?needle ?name
LIMIT ${PAGE}
OFFSET ${offset}`;
}

const val = (binding, key) => binding?.[key]?.value ?? '';

/**
 * Candidates from LINDAS bindings. Sole proprietorships and firms in
 * liquidation are skipped. The purpose text itself is graded and dropped.
 */
export function zefixCandidates(bindings) {
  const out = [];
  const seen = new Set();
  for (const b of bindings ?? []) {
    if (val(b, 'form') === SOLE_PROPRIETORSHIP) continue;
    const uid = val(b, 'uid').split('/UID/')[1];
    const legalName = val(b, 'name').trim();
    if (!uid || !legalName || IN_LIQUIDATION.test(legalName)) continue;
    const needle = val(b, 'needle');
    const id = `${needle}|${uid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      needle,
      legalName,
      entityId: `uid:${uid}`,
      place: val(b, 'city'),
      postcode: val(b, 'pc'),
      country: 'CH',
      purpose: purposeStrength(val(b, 'd')),
    });
  }
  return out;
}

/** Candidates from one recherche-entreprises answer: the seat plus open establishments. */
export function sireneCandidates(apiResult, needle) {
  const out = [];
  for (const r of apiResult?.results ?? []) {
    if (String(r.nature_juridique ?? '').startsWith('1')) continue;
    const siren = String(r.siren ?? '').trim();
    const legalName = String(r.nom_complet ?? '').trim();
    if (!siren || !legalName) continue;
    const sites = [r.siege, ...(r.matching_etablissements ?? []).filter((e) => e?.etat_administratif !== 'F')];
    const seen = new Set();
    for (const s of sites) {
      if (!s) continue;
      const postcode = String(s.code_postal ?? '');
      const place = String(s.libelle_commune ?? '');
      const id = `${postcode}|${place}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        needle,
        legalName,
        entityId: `siren:${siren}`,
        place,
        postcode,
        country: 'FR',
        sector: r.activite_principale ?? '',
        sizeBand: sizeBand(r.tranche_effectif_salarie),
      });
    }
  }
  return out;
}

const PURPOSE_RANK = { strong: 2, weak: 1 };

function groupEntities(candidates) {
  const byId = new Map();
  for (const c of candidates) {
    let e = byId.get(c.entityId);
    if (!e) {
      e = { entityId: c.entityId, legalName: c.legalName, sites: [], purpose: null, sector: '', sizeBand: '?' };
      byId.set(c.entityId, e);
    }
    if (!e.sites.some((s) => s.place === c.place && s.postcode === c.postcode)) {
      e.sites.push({ place: c.place, postcode: c.postcode, country: c.country });
    }
    if ((PURPOSE_RANK[c.purpose] ?? 0) > (PURPOSE_RANK[e.purpose] ?? 0)) e.purpose = c.purpose;
    if (!e.sector && c.sector) e.sector = c.sector;
    if (e.sizeBand === '?' && c.sizeBand) e.sizeBand = c.sizeBand;
  }
  return [...byId.values()];
}

/**
 * The pick rule: exact legal-name base key, else exactly one in-zone prefix
 * entity, else ambiguous, else out-of-zone, else unresolved.
 *
 * @returns {{verdict:'resolved'|'ambiguous'|'out-of-zone'|'unresolved', entity?:object, site?:object, candidates:object[]}}
 */
export function chooseEntity(needle, candidates, { table }) {
  const entities = groupEntities(candidates);
  const zoned = (e) => e.sites.find((s) => /^[A-D]$/.test(resolveZone(table, s).zone ?? ''));
  const exact = entities.filter((e) => baseKey(e.legalName) === needle.base);
  if (exact.length > 1) return { verdict: 'ambiguous', candidates: exact };
  if (exact.length === 1) {
    const site = zoned(exact[0]);
    return site
      ? { verdict: 'resolved', entity: exact[0], site, candidates: exact }
      : { verdict: 'out-of-zone', candidates: exact };
  }
  const prefix = entities.filter((e) => baseKey(e.legalName).startsWith(`${needle.base} `));
  const inZone = prefix.filter(zoned);
  if (inZone.length === 1) return { verdict: 'resolved', entity: inZone[0], site: zoned(inZone[0]), candidates: inZone };
  if (inZone.length > 1) return { verdict: 'ambiguous', candidates: inZone };
  if (prefix.length > 0) return { verdict: 'out-of-zone', candidates: prefix };
  return { verdict: 'unresolved', candidates: [] };
}

const cleanName = (s) => String(s ?? '').replace(/[;#]/g, ',').replace(/[\t\r\n]+/g, ' ').trim();

/** `legal @ place (postcode) #entity_id` entries joined by `;`, at most 20 plus `+N more`. */
export function formatCandidates(entities) {
  const entries = entities.slice(0, MAX_LISTED).map((e) => {
    const site = e.sites[0] ?? { place: '', postcode: '' };
    return `${cleanName(e.legalName)} @ ${cleanName(site.place)} (${cleanName(site.postcode)}) #${e.entityId}`;
  });
  if (entities.length > MAX_LISTED) entries.push(`+${entities.length - MAX_LISTED} more`);
  return entries.join(';');
}

const ENTRY = /^(.*?) @ (.*) \(([^()]*)\) #(\S+)$/;

/** Inverse of formatCandidates. Entries it cannot parse are ignored. */
export function parseCandidates(cell) {
  const out = [];
  for (const piece of String(cell ?? '').split(';')) {
    const m = ENTRY.exec(piece.trim());
    if (m) out.push({ legalName: m[1], place: m[2], postcode: m[3], entityId: m[4] });
  }
  return out;
}
