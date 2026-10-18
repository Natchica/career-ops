/**
 * radar/sources/sirene.mjs — French employers from the public company-search
 * API (recherche-entreprises.api.gouv.fr, built on the SIRENE register).
 *
 * Vetted 2026-10-18: no robots.txt, no key, open data under Licence Ouverte
 * 2.0, documented at 7 calls per second. This source paces at 3 per second.
 * Attribution: "Source : base SIRENE de l'INSEE, via recherche-entreprises.api.gouv.fr".
 *
 * One query per postcode of the French places in the zone table, filtered to
 * active units with salaried employees. A record is emitted per matching
 * establishment, so the site is where the staff are, never the head office.
 *
 * Personal data never leaves this file: `dirigeants` is not read, and sole
 * proprietors (legal category 1xxx), whose company name is a person's name, are
 * skipped. Only these fields reach a record: name, legal name, SIREN, place,
 * postcode, activity code, size band.
 *
 * The API caps `page * per_page` at 10000. A postcode that exceeds it is split
 * by activity section, then by size tranche, so no sweep reads past the cap.
 */

import { fetchJsonWithRetry } from '../../providers/_http.mjs';

const BASE = 'https://recherche-entreprises.api.gouv.fr/search';
const PER_PAGE = 25;
const MAX_RESULTS = 10_000;
const MAX_PAGES = MAX_RESULTS / PER_PAGE;
const PACE_MS = 340;
const SECTIONS = 'ABCDEFGHIJKLMNOPQRSTU'.split('');
/** Size tranches with at least one salaried employee. 00 and NN carry none. */
const EMPLOYER_TRANCHES = ['01', '02', '03', '11', '12', '21', '22', '31', '32', '41', '42', '51', '52', '53'];

const BANDS = {
  '01': '1-2', '02': '3-5', '03': '6-9', '11': '10-19', '12': '20-49', '21': '50-99',
  '22': '100-199', '31': '200-249', '32': '250-499', '41': '500-999', '42': '1000-1999',
  '51': '2000-4999', '52': '5000-9999', '53': '10000+',
};

/** INSEE `tranche_effectif_salarie` to a size band. Unknown or zero gives `?`. */
export function sizeBand(code) {
  return BANDS[String(code ?? '')] ?? '?';
}

/** The 5-digit French postcodes of the zones in play, from the zone table. */
export function zonePostcodes(table, zones) {
  const seen = new Set();
  for (const r of table.ranges) {
    if (r.place.country !== 'FR' || !r.place.zone || r.digits !== 5) continue;
    if (zones && !zones.includes(r.place.zone)) continue;
    for (let n = r.from; n <= r.to; n++) seen.add(String(n).padStart(5, '0'));
  }
  return [...seen];
}

function toRecords(result) {
  if (String(result.nature_juridique ?? '').startsWith('1')) return [];
  const name = (result.nom_raison_sociale || result.nom_complet || '').trim();
  if (!name || !result.siren) return [];
  return (result.matching_etablissements ?? []).map((et) => ({
    name,
    legalName: (result.nom_complet || name).trim(),
    entityId: `siren:${result.siren}`,
    place: et.libelle_commune,
    postcode: et.code_postal,
    country: 'FR',
    activityCode: result.activite_principale ?? undefined,
    sector: result.activite_principale ?? '',
    sizeBand: sizeBand(result.tranche_effectif_salarie),
    sourceId: 'sirene',
    evidence: `sirene:${result.siren}`,
  }));
}

export default {
  id: 'sirene',
  family: 'register',
  auth: { kind: 'none', vars: [] },

  async *fetch(ctx) {
    const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let requests = 0;

    const get = async (cp, filter, page) => {
      if (requests++ > 0) await sleep(PACE_MS);
      const params = new URLSearchParams({
        code_postal: cp,
        tranche_effectif_salarie: filter.tranches.join(','),
        etat_administratif: 'A',
      });
      if (filter.section) params.set('section_activite_principale', filter.section);
      params.set('per_page', String(PER_PAGE));
      params.set('page', String(page));
      return fetchJsonWithRetry(ctx.http, `${BASE}?${params}`);
    };

    async function* sweep(cp, filter) {
      const first = await get(cp, filter, 1);
      if ((first.total_results ?? 0) >= MAX_RESULTS) {
        if (!filter.section) {
          for (const section of SECTIONS) yield* sweep(cp, { ...filter, section });
          return;
        }
        if (filter.tranches.length > 1) {
          for (const tranche of filter.tranches) yield* sweep(cp, { ...filter, tranches: [tranche] });
          return;
        }
        ctx.log?.(`sirene: ${cp} section ${filter.section} tranche ${filter.tranches[0]} exceeds the cap; reading the first ${MAX_RESULTS}`);
      }
      for (const result of first.results ?? []) yield* toRecords(result);
      const pages = Math.min(first.total_pages ?? 1, MAX_PAGES);
      for (let page = 2; page <= pages; page++) {
        const body = await get(cp, filter, page);
        for (const result of body.results ?? []) yield* toRecords(result);
      }
    }

    const postcodes = ctx.postcodes ?? zonePostcodes(ctx.table, ctx.zones ?? null);
    for (const [index, cp] of postcodes.entries()) {
      const progress = () => ctx.log?.(`sirene: ${cp} done (${index + 1}/${postcodes.length})`);
      const cached = ctx.cache?.get(cp);
      if (cached) {
        yield* cached;
        progress();
        continue;
      }
      const records = [];
      for await (const record of sweep(cp, { tranches: EMPLOYER_TRANCHES })) {
        records.push(record);
        yield record;
      }
      ctx.cache?.set(cp, records);
      progress();
    }
  },
};
