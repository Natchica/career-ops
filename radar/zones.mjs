/**
 * radar/zones.mjs — map a place, postcode or free-text location to a commute
 * zone (A-D of modes/_brief.md) for the company radar.
 *
 * The table lives in templates/radar-zones.yml. A user override at
 * {dataRoot}/config/radar-zones.yml wins when present; a missing override
 * (ENOENT) falls back to the template, a present but unparseable one throws
 * RadarConfigError and never falls back, so a broken user file stays visible.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

export class RadarConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RadarConfigError';
  }
}

const ZONES = new Set(['A', 'B', 'C', 'D']);
const COUNTRIES = new Set(['CH', 'FR', 'DE']);

/** Lower-case, strip diacritics, collapse separators so names compare equal. */
export function foldName(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parsePostcodeSpec(spec, where) {
  const text = String(spec).trim();
  const m = /^(\d{4,5})(?:-(\d{4,5}))?$/.exec(text);
  if (!m) throw new RadarConfigError(`${where}: bad postcode "${text}"`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) throw new RadarConfigError(`${where}: postcode range "${text}" is reversed`);
  return { from, to, digits: m[1].length };
}

function buildTable(doc, source) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.places)) {
    throw new RadarConfigError(`${source}: expected a "places" list`);
  }
  const places = [];
  const byName = new Map();
  const ranges = [];
  doc.places.forEach((raw, i) => {
    const where = `${source}: places[${i}]`;
    if (!raw || typeof raw !== 'object') throw new RadarConfigError(`${where} is not a mapping`);
    const zone = raw.zone === null || raw.zone === undefined ? null : String(raw.zone);
    if (zone !== null && !ZONES.has(zone)) throw new RadarConfigError(`${where}: bad zone "${raw.zone}"`);
    if (!COUNTRIES.has(raw.country)) throw new RadarConfigError(`${where}: bad country "${raw.country}"`);
    if (typeof raw.name !== 'string' || !raw.name.trim()) throw new RadarConfigError(`${where}: missing name`);
    const place = {
      zone,
      country: raw.country,
      name: raw.name.trim(),
      aliases: (raw.aliases ?? []).map(String),
      default: raw.default === true,
    };
    places.push(place);
    for (const label of [place.name, ...place.aliases]) {
      const key = foldName(label);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      if (!byName.get(key).includes(place)) byName.get(key).push(place);
    }
    for (const spec of raw.postcodes ?? []) {
      ranges.push({ ...parsePostcodeSpec(spec, where), place });
    }
  });
  return { places, byName, ranges };
}

/**
 * @param {{dataRoot: string, codeRoot: string}} roots
 * @returns the zone table used by resolveZone and resolveFreeText
 */
export function loadZoneTable({ dataRoot, codeRoot }) {
  const overridePath = join(dataRoot, 'config', 'radar-zones.yml');
  let text;
  let source = overridePath;
  try {
    text = readFileSync(overridePath, 'utf-8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw new RadarConfigError(`${overridePath}: ${e.message}`);
    source = join(codeRoot, 'templates', 'radar-zones.yml');
    text = readFileSync(source, 'utf-8');
  }
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new RadarConfigError(`${source}: ${e.message}`);
  }
  return { ...buildTable(doc, source), source };
}

function pickByName(candidates, country) {
  let list = candidates;
  if (country) list = list.filter((p) => p.country === country);
  if (list.length === 0) return { place: null, reason: 'out' };
  if (list.length === 1) return { place: list[0] };
  const preferred = list.filter((p) => p.default);
  if (preferred.length === 1) return { place: preferred[0] };
  return { place: null, reason: 'ambiguous' };
}

/**
 * Resolve one structured location. A postcode wins over a place name.
 *
 * @returns {{zone:'A'|'B'|'C'|'D', place:string, country:string} |
 *           {zone:null, reason:'out'|'ambiguous'|'unparsed'}}
 */
export function resolveZone(table, { place, postcode, country } = {}) {
  const digits = String(postcode ?? '').replace(/\s+/g, '');
  if (/^\d{4,5}$/.test(digits)) {
    const n = Number(digits);
    const hit = table.ranges.find(
      (r) => r.digits === digits.length && n >= r.from && n <= r.to && (!country || r.place.country === country),
    );
    if (hit) {
      return hit.place.zone
        ? { zone: hit.place.zone, place: hit.place.name, country: hit.place.country }
        : { zone: null, reason: 'out' };
    }
    if (!place) return { zone: null, reason: 'out' };
  }
  if (place && String(place).trim()) {
    const found = pickByName(table.byName.get(foldName(place)) ?? [], country);
    if (!found.place) return { zone: null, reason: found.reason };
    return found.place.zone
      ? { zone: found.place.zone, place: found.place.name, country: found.place.country }
      : { zone: null, reason: 'out' };
  }
  return { zone: null, reason: 'unparsed' };
}

const COUNTRY_WORDS = new Map([
  ['switzerland', 'CH'], ['suisse', 'CH'], ['schweiz', 'CH'], ['svizzera', 'CH'], ['ch', 'CH'],
  ['france', 'FR'], ['frankreich', 'FR'], ['fr', 'FR'],
  ['germany', 'DE'], ['deutschland', 'DE'], ['allemagne', 'DE'], ['de', 'DE'],
]);

/**
 * Resolve a free-text location such as `STRASBOURG (67)`, `Switzerland - Zurich`
 * or `Basel · Remote` to the in-zone sites it names. Tokens split on commas,
 * dots-in-the-middle, bars, ampersands, parentheses, slashes, semicolons and a
 * spaced dash. A country word or a two-digit French department is a hint for
 * the other tokens. Names that resolve out of zone, ambiguously or not at all
 * (`Remote`, `Paris`) add nothing.
 *
 * @returns {{place:string, zone:string, country:string}[]}
 */
export function resolveFreeText(table, text) {
  const tokens = String(text ?? '')
    .split(/\s[-–—]\s|[,·|&()/;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const hints = new Set();
  const names = [];
  for (const token of tokens) {
    const folded = foldName(token);
    if (COUNTRY_WORDS.has(folded)) hints.add(COUNTRY_WORDS.get(folded));
    else if (/^\d{2}$/.test(token)) hints.add('FR');
    else names.push(token);
  }
  const country = hints.size === 1 ? [...hints][0] : undefined;
  const sites = [];
  const seen = new Set();
  for (const name of names) {
    const r = resolveZone(table, { place: name, country });
    if (!r.zone) continue;
    const key = `${r.country}|${r.place}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push({ place: r.place, zone: r.zone, country: r.country });
  }
  return sites;
}

/**
 * Attach the in-zone sites to a raw source record. A record with
 * `locationText` is zoned from free text, any other from its place and
 * postcode. `sites` is empty when nothing resolves into zones A to D, and the
 * caller counts that record as unzoned. `country` defaults to the first site's.
 */
export function zoneRecord(table, raw) {
  let sites;
  if (raw.locationText !== undefined) {
    sites = resolveFreeText(table, raw.locationText);
  } else {
    const r = resolveZone(table, { place: raw.place, postcode: raw.postcode, country: raw.country });
    sites = r.zone ? [{ place: r.place, zone: r.zone, country: r.country }] : [];
  }
  return { ...raw, sites, country: raw.country ?? sites[0]?.country };
}
