/**
 * radar/identity.mjs — turn raw company records into Prospects.
 *
 * One Prospect per brand or group. Legal entities and spellings are aliases.
 * Merging is deliberately conservative (no fuzzy matching):
 *   - names merge when their base keys are equal, after the optional
 *     `company_aliases` canonicalizer from portals.yml has run;
 *   - a legal form (SAS, GmbH, AG, ...) is stripped, a descriptor (Pharma,
 *     Solutions, ...) never is;
 *   - two records carrying different register ids of the same kind (for
 *     example two SIRENs) under one name are different entities: the second
 *     gets `<key>|<country>|<first site>` and is reported in `collisions`,
 *     never merged silently.
 *
 * A registry row is a plain object of string cells keyed by column name. Cells
 * this module does not own (`notes`, any column a later stage adds) pass
 * through untouched.
 */

import { foldName } from './zones.mjs';

/** APE/NAF rev.2 codes whose holders are software or IT-service firms. */
export const SOFTWARE_NAF = new Set([
  '58.21Z', '58.29A', '58.29B', '58.29C',
  '62.01Z', '62.02A', '62.02B', '62.03Z', '62.09Z',
  '63.11Z', '63.12Z',
]);

const LEGAL_FORMS = [
  ['s', 'a', 'r', 'l'], ['s', 'a', 's', 'u'], ['s', 'a', 's'], ['s', 'a'],
  ['e', 'u', 'r', 'l'], ['e', 'k'],
  ['sarl'], ['sasu'], ['sas'], ['sa'], ['eurl'], ['sca'], ['scs'],
  ['gmbh'], ['mbh'], ['ag'], ['kg'], ['ug'], ['ohg'], ['se'],
  ['ltd'], ['limited'], ['llc'], ['inc'], ['corp'], ['plc'], ['co'],
  ['nv'], ['bv'], ['spa'], ['srl'],
];

/**
 * Folded company name with parentheticals and trailing legal forms removed.
 * Never returns an empty string for a non-empty name.
 */
export function baseKey(name) {
  const withoutParens = String(name ?? '').replace(/\([^)]*\)/g, ' ');
  let tokens = foldName(withoutParens).split(' ').filter(Boolean);
  if (tokens.length === 0) tokens = foldName(name).split(' ').filter(Boolean);
  let stripped = true;
  while (stripped && tokens.length > 1) {
    stripped = false;
    for (const form of LEGAL_FORMS) {
      if (tokens.length > form.length && form.every((t, i) => tokens[tokens.length - form.length + i] === t)) {
        tokens = tokens.slice(0, tokens.length - form.length);
        stripped = true;
        break;
      }
    }
  }
  return tokens.join(' ');
}

export const splitList = (cell) => String(cell ?? '').split(';').map((s) => s.trim()).filter(Boolean);
export const joinList = (items) => items.join(';');

function union(existing, additions) {
  const out = [...existing];
  for (const item of additions) if (item && !out.includes(item)) out.push(item);
  return out;
}

/**
 * Independent tech signals for a row, 0 to 4: an ATS board, a GitHub org, a
 * directory listing, a software activity code. A count, never a filter.
 * Source tokens: `ats-employers:board` marks board evidence, as opposed to a
 * company merely seen in scan history.
 */
export function countSignals(row) {
  const sources = splitList(row.sources);
  const code = String(row.sector ?? '').trim().split(/\s+/)[0];
  let n = 0;
  if (sources.includes('ats-employers:board')) n++;
  if (sources.includes('github-orgs')) n++;
  if (sources.includes('directories')) n++;
  if (SOFTWARE_NAF.has(code)) n++;
  return n;
}

function keyFor(name, canon) {
  return baseKey(canon(name));
}

function entityTokens(row) {
  return splitList(row.aliases).filter((a) => a.startsWith('#'));
}

function conflicts(row, entityId) {
  if (!entityId) return false;
  const kind = entityId.split(':')[0];
  const mine = entityTokens(row).map((t) => t.slice(1)).filter((t) => t.split(':')[0] === kind);
  return mine.length > 0 && !mine.includes(entityId);
}

function emptyRow(key, name) {
  return {
    key, name, aliases: '', sites: '', country: '', sector: '', size_band: '?', signals: '0',
    sources: '', first_seen: '', last_seen: '', portals_ref: '—', notes: '',
  };
}

/**
 * Fold zoned records into registry rows.
 *
 * @param {Record<string,string>[]} rows existing registry rows (not mutated)
 * @param {object[]} records zoned records: {name, legalName?, entityId?, sites,
 *   country, sector?, sizeBand?, sourceId, boardSignal?}
 * @param {{canon:(n:string)=>string, today:string, portalsNames:Map<string,string>}} ctx
 * @returns {{rows:Record<string,string>[], newKeys:string[], knownKeys:string[], collisions:object[]}}
 */
export function mergeRecords(rows, records, { canon, today, portalsNames }) {
  const out = rows.map((r) => ({ ...r }));
  const index = new Map(out.map((r) => [r.key, r]));
  const newKeys = [];
  const knownKeys = [];
  const collisions = [];

  for (const record of records) {
    const baseK = keyFor(record.name, canon);
    if (!baseK) continue;
    let key = baseK;
    let row = index.get(key);
    if (row && conflicts(row, record.entityId)) {
      const site = foldName(record.sites?.[0]?.place ?? 'unknown').replace(/ /g, '-');
      key = `${baseK}|${record.country}|${site}`;
      row = index.get(key);
      collisions.push({ key: baseK, name: record.name, entityId: record.entityId, resolvedKey: key });
    }
    const isNew = !row;
    if (!row) {
      row = emptyRow(key, record.name.trim());
      row.country = record.country;
      row.first_seen = today;
      out.push(row);
      index.set(key, row);
    }
    if (isNew) {
      if (!newKeys.includes(key)) newKeys.push(key);
    } else if (!newKeys.includes(key) && !knownKeys.includes(key)) {
      knownKeys.push(key);
    }

    const aliasAdds = [];
    if (record.legalName && record.legalName.trim() !== row.name) aliasAdds.push(record.legalName.trim());
    if (record.name.trim() !== row.name) aliasAdds.push(record.name.trim());
    if (record.entityId) aliasAdds.push(`#${record.entityId}`);
    row.aliases = joinList(union(splitList(row.aliases), aliasAdds));

    const siteCells = (record.sites ?? []).map((s) => `${s.place}:${s.zone}`);
    row.sites = joinList(union(splitList(row.sites), siteCells));

    if (!row.sector && record.sector) row.sector = record.sector;
    if (record.sizeBand && record.sizeBand !== '?') row.size_band = record.sizeBand;

    const sourceAdds = [record.sourceId];
    if (record.sourceId === 'ats-employers' && record.boardSignal) sourceAdds.push('ats-employers:board');
    row.sources = joinList(union(splitList(row.sources), sourceAdds));
    row.signals = String(countSignals(row));
    row.last_seen = today;

    if ((!row.portals_ref || row.portals_ref === '—') && portalsNames.has(baseK)) {
      row.portals_ref = portalsNames.get(baseK);
    }
  }
  return { rows: out, newKeys, knownKeys, collisions };
}
