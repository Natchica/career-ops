/**
 * Tier rules for the radar registry: load the rule file, never touch the network.
 * A present override that fails to parse or has the wrong shape throws
 * RadarConfigError and never falls back, so a broken user file stays visible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { RadarConfigError, foldName, loadZoneTable } from './zones.mjs';
import { hintScore } from './hints.mjs';
import { splitList } from './identity.mjs';

const ZONES = ['A', 'B', 'C', 'D'];
const FOCUS_COUNTRIES = ['CH', 'FR', 'DE'];
const FLOOR_CODE = /^\d{2}\.\d{2}[A-Z]$/;
const DIVISION = /^\d{2}$/;
const KNOWN_BANDS = ['10000+', '5000-9999', '2000-4999', '1000-1999', '500-999', '250-499', '200-249', '100-199', '50-99', '20-49', '10-19', '?', '6-9', '3-5', '1-2'];

const isList = (v) => Array.isArray(v);

function buildRules(doc, source) {
  const fail = (msg) => { throw new RadarConfigError(`${source}: ${msg}`); };
  if (!doc || typeof doc !== 'object') fail('expected a mapping');
  if (doc.version !== 1) fail(`unsupported version "${doc.version}"`);

  const hard = doc.hard_out;
  if (!hard || typeof hard !== 'object') fail('missing hard_out');
  const floor = hard.floor ?? [];
  if (!isList(floor)) fail('hard_out.floor must be a list');
  for (const f of floor) {
    if (!FLOOR_CODE.test(String(f?.code ?? ''))) fail(`floor code "${f?.code}" is not a NAF code like 25.40Z`);
  }
  const divisions = hard.divisions ?? [];
  if (!isList(divisions)) fail('hard_out.divisions must be a list');
  for (const d of divisions) {
    if (!DIVISION.test(String(d?.division ?? ''))) fail(`division "${d?.division}" is not 2 digits`);
  }
  const sizeBands = hard.size_bands ?? [];
  if (!isList(sizeBands) || sizeBands.some((b) => !KNOWN_BANDS.includes(b))) fail('hard_out.size_bands holds an unknown band');

  const patterns = hard.non_employer_patterns ?? [];
  if (!isList(patterns)) fail('hard_out.non_employer_patterns must be a list');
  const nonEmployer = patterns.map((p, i) => {
    if (typeof p?.pattern !== 'string' || !p.pattern) fail(`non_employer_patterns[${i}] needs a pattern`);
    try { return { re: new RegExp(p.pattern, 'iu'), label: String(p.label ?? p.pattern) }; }
    catch (e) { fail(`non_employer_patterns[${i}] "${p.pattern}" does not compile: ${e.message}`); }
  });

  const unverified = doc.unverified_sources ?? ['github-orgs'];
  if (!isList(unverified) || unverified.some((u) => typeof u !== 'string' || !u.trim())) fail('unverified_sources must be a list of source ids');

  const poolZones = doc.pool_zones;
  if (!isList(poolZones) || poolZones.length === 0 || poolZones.some((z) => !ZONES.includes(z))) {
    fail('pool_zones must be a non-empty subset of A, B, C, D');
  }

  const tiers = doc.tiers;
  if (!isList(tiers) || tiers.length === 0) fail('tiers must be a non-empty list');
  for (const t of tiers) {
    if (![1, 2, 3].includes(t?.tier) || !Number.isInteger(t?.min_signals) || t.min_signals < 0) fail('each tier needs tier 1-3 and min_signals >= 0');
  }

  const order = doc.order;
  if (!order || typeof order !== 'object') fail('missing order');
  if (!isList(order.zones) || order.zones.some((z) => !ZONES.includes(z))) fail('order.zones must list zones A-D');
  if (!isList(order.countries) || order.countries.some((g) => !isList(g))) fail('order.countries must be a list of country groups');
  const bands = order.size_bands;
  if (!isList(bands) || bands.length !== KNOWN_BANDS.length || KNOWN_BANDS.some((b) => bands.filter((x) => x === b).length !== 1)) {
    fail('order.size_bands must list each known band exactly once');
  }

  const focus = doc.focus_country ?? null;
  if (focus !== null && !FOCUS_COUNTRIES.includes(focus)) fail(`focus_country must be one of ${FOCUS_COUNTRIES.join(', ')}, got "${focus}"`);

  return {
    version: 1,
    focusCountry: focus,
    floor: floor.map((f) => ({ code: String(f.code), label: String(f.label ?? '') })),
    blacklist: hard.blacklist !== false,
    divisions: divisions.map((d) => ({ division: String(d.division), label: String(d.label ?? '') })),
    hardOutSizes: [...sizeBands],
    nonEmployer,
    unverifiedSources: unverified.map((u) => u.trim()),
    poolZones: [...poolZones],
    tiers: tiers.map((t) => ({ tier: t.tier, minSignals: t.min_signals })),
    order: { zones: [...order.zones], countries: order.countries.map((g) => [...g]), sizeBands: [...bands] },
  };
}

/**
 * @param {{dataRoot: string, codeRoot: string}} roots
 * @returns the validated rules, with `source` naming the file they came from
 */
export function loadTierRules({ dataRoot, codeRoot }) {
  const overridePath = join(dataRoot, 'config', 'radar-tiers.yml');
  let text;
  let source = overridePath;
  try {
    text = readFileSync(overridePath, 'utf-8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw new RadarConfigError(`${overridePath}: ${e.message}`);
    source = join(codeRoot, 'templates', 'radar-tiers.yml');
    text = readFileSync(source, 'utf-8');
  }
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new RadarConfigError(`${source}: ${e.message}`);
  }
  const rules = { ...buildRules(doc, source), source, focusPlaces: null };
  if (rules.focusCountry) rules.focusPlaces = placesIn(rules.focusCountry, loadZoneTable({ dataRoot, codeRoot }));
  return rules;
}

/**
 * Folded names of the zone-table places that belong to `country`. A name the
 * table also gives to a place in another country is left out, so a shared name
 * never counts as a site in the focus country.
 */
function placesIn(country, table) {
  const inside = new Set();
  const outside = new Set();
  for (const place of table.places) {
    const bucket = place.country === country ? inside : outside;
    for (const label of [place.name, ...place.aliases]) {
      const key = foldName(label);
      if (key) bucket.add(key);
    }
  }
  for (const key of outside) inside.delete(key);
  return inside;
}

const NAF_CODE = /^\d{2}\.\d{2}[A-Z]/;
const sectorToken = (row) => String(row.sector ?? '').trim().split(/\s+/)[0] ?? '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Smallest zone letter among the row's `place:zone` sites that is inside the pool (and in the focus country, when set), or null. */
export function bestZone(row, rules) {
  let best = null;
  for (const site of String(row.sites ?? '').split(';')) {
    const at = site.lastIndexOf(':');
    const zone = site.slice(at + 1).trim();
    if (!rules.poolZones.includes(zone)) continue;
    if (rules.focusPlaces && !rules.focusPlaces.has(foldName(site.slice(0, at)))) continue;
    if (best === null || zone < best) best = zone;
  }
  return best;
}

/** The Prospect's name and its alias spellings, without the `#` register ids. */
export function prospectNames(row) {
  const aliases = String(row.aliases ?? '').split(';').map((a) => a.trim()).filter((a) => a && !a.startsWith('#'));
  return [row.name, ...aliases].filter(Boolean);
}

/** True when the row carries a board: a portals_ref or the `ats-employers:board` source token. */
export function hasBoard(row) {
  return (Boolean(row.portals_ref) && row.portals_ref !== '—')
    || splitList(row.sources).includes('ats-employers:board');
}

/**
 * An unverified employer is known only from sources that never confirm a company
 * exists (GitHub organisations): no register id alias, no board.
 */
export function isUnverified(row, rules) {
  const tokens = splitList(row.sources).filter((t) => !t.includes(':'));
  return tokens.length > 0 && tokens.every((t) => (rules.unverifiedSources ?? []).includes(t))
    && !splitList(row.aliases).some((a) => a.startsWith('#uid:') || a.startsWith('#siren:'))
    && !hasBoard(row);
}

const VALID_OVERRIDES = new Set(['1', '2', '3', 'out']);

/**
 * Rank one Prospect. Hard-outs run first, in the rule file's order; the first
 * match is the recorded reason. A valid `tier_override` wins over the result.
 *
 * @returns {{tier: '1'|'2'|'3'|'out', reason: string, invalidOverride: boolean,
 *            trace: {rule: string, result: string, detail: string}[]}}
 */
export function classify(row, rules, { isBlacklisted = () => false } = {}) {
  const trace = [];
  const note = (rule, result, detail = '') => trace.push({ rule, result, detail });
  const token = sectorToken(row);
  const size = String(row.size_band ?? '').trim() || '?';
  let tier = null;
  let reason = '';

  const floor = rules.floor.find((f) => f.code === token);
  note('floor', floor ? 'out' : 'pass', floor ? floor.code : '');
  if (floor) { tier = 'out'; reason = `out floor: ${floor.code} ${floor.label}`; }

  const listed = rules.blacklist && !tier && isBlacklisted(row);
  note('blacklist', listed ? 'out' : 'pass');
  if (listed) { tier = 'out'; reason = `out blacklist: ${row.name}`; }

  const unverified = isUnverified(row, rules);
  const hit = !tier && unverified ? (rules.nonEmployer ?? []).find((p) => prospectNames(row).some((n) => p.re.test(n))) : undefined;
  note('non-employer', tier || !unverified ? 'skipped' : hit ? 'out' : 'pass', hit?.label ?? (unverified ? '' : 'verified employer'));
  if (hit) { tier = 'out'; reason = `out non-employer: ${hit.label}`; }

  const division = NAF_CODE.test(token) ? rules.divisions.find((d) => d.division === token.slice(0, 2)) : undefined;
  note('sector', tier ? 'skipped' : division ? 'out' : 'pass', division?.division ?? '');
  if (!tier && division) { tier = 'out'; reason = `out sector: ${division.division} ${division.label}`; }

  const smallSize = rules.hardOutSizes.includes(size);
  note('size', tier ? 'skipped' : smallSize ? 'out' : 'pass', size);
  if (!tier && smallSize) { tier = 'out'; reason = `out size: ${size}`; }

  const zone = bestZone(row, rules);
  note('zone', tier ? 'skipped' : zone ? 'pass' : 'unknown', zone ?? '');
  if (!tier && !zone) {
    tier = '3';
    reason = rules.focusCountry ? `tier 3: no ${rules.focusCountry} site` : 'unknown: no zone A-D';
  }

  const signals = Number.parseInt(row.signals, 10) || 0;
  const match = tier ? undefined : rules.tiers.find((t) => signals >= t.minSignals);
  note('tier', tier ? 'skipped' : match ? String(match.tier) : '3', `${signals} signals`);
  if (!tier) {
    tier = match ? String(match.tier) : '3';
    reason = `tier ${tier}: zone ${zone}, ${row.country}, ${plural(signals, 'signal')}`;
    if (size === '?') reason += '; size ?';
    if (!String(row.sector ?? '').trim()) reason += '; no NAF code';
  }

  const only = `${splitList(row.sources).filter((t) => !t.includes(':')).join(', ')} only`;
  note('unverified', !unverified ? 'skipped' : tier === '1' ? '2' : 'pass', unverified ? only : '');
  if (unverified && tier === '1') { tier = '2'; reason = `tier 2: unverified employer (${only}); ${reason.slice('tier 1: '.length)}`; }

  const given = String(row.tier_override ?? '').trim();
  const valid = VALID_OVERRIDES.has(given);
  if (valid) {
    reason = `override: ${given} (rules: ${tier}, ${reason})`;
    tier = given;
  }
  return { tier, reason, invalidOverride: given !== '' && !valid, trace };
}

const indexOrEnd = (list, value) => { const i = list.indexOf(value); return i === -1 ? list.length : i; };
const groupIndex = (groups, country) => { const i = groups.findIndex((g) => g.includes(country)); return i === -1 ? groups.length : i; };
const signalCount = (p) => Number.parseInt(p.signals, 10) || 0;

/** Order two Prospects of one tier: zone, country group, hints, signals, size, then key. */
export function compareProspects(a, b, rules) {
  const za = indexOrEnd(rules.order.zones, bestZone(a, rules));
  const zb = indexOrEnd(rules.order.zones, bestZone(b, rules));
  if (za !== zb) return za - zb;
  const ca = groupIndex(rules.order.countries, a.country);
  const cb = groupIndex(rules.order.countries, b.country);
  if (ca !== cb) return ca - cb;
  if (hintScore(a) !== hintScore(b)) return hintScore(b) - hintScore(a);
  if (signalCount(a) !== signalCount(b)) return signalCount(b) - signalCount(a);
  const sa = indexOrEnd(rules.order.sizeBands, String(a.size_band || '?'));
  const sb = indexOrEnd(rules.order.sizeBands, String(b.size_band || '?'));
  if (sa !== sb) return sa - sb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `spontaneous` cell: `drafted:D`, `skipped:D[:why]` or `sent:D:#N`.
 * @returns {{state: 'none'|'drafted'|'skipped'|'sent'|'invalid', date?: string, tracker?: number, why?: string}}
 */
export function parseSpontaneous(cell) {
  const text = String(cell ?? '').trim();
  if (text === '') return { state: 'none' };
  const [state, date, ...rest] = text.split(':');
  if (!DATE.test(date ?? '')) return { state: 'invalid' };
  const tail = rest.join(':');
  if (state === 'drafted' && rest.length === 0) return { state, date };
  if (state === 'skipped') return tail ? { state, date, why: tail } : { state, date };
  if (state === 'sent') {
    const m = /^#(\d+)$/.exec(tail);
    return m ? { state, date, tracker: Number(m[1]) } : { state: 'invalid' };
  }
  return { state: 'invalid' };
}

export function formatSpontaneous({ state, date, tracker, why }) {
  if (state === 'none') return '';
  if (state === 'sent') return `sent:${date}:#${tracker}`;
  if (state === 'skipped' && why) return `skipped:${date}:${why}`;
  return `${state}:${date}`;
}

/**
 * The Prospects `discover-ats.mjs --from-radar` should probe for an ATS board:
 * tier 1 or 2, no board yet, optionally with a site in one of `zones`, in tier
 * order, at most `limit`.
 */
export function selectForDiscovery(rows, rules, { zones = null, limit = 20 } = {}) {
  const wanted = Array.isArray(zones) && zones.length ? new Set(zones) : null;
  const inZone = (p) => !wanted
    || String(p.sites ?? '').split(';').some((site) => wanted.has(site.split(':').pop()?.trim()));
  return rows
    .filter((p) => (p.tier === '1' || p.tier === '2') && !hasBoard(p) && inZone(p))
    .sort((a, b) => (a.tier === b.tier ? compareProspects(a, b, rules) : a.tier < b.tier ? -1 : 1))
    .slice(0, limit);
}
