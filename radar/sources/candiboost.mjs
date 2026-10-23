/**
 * radar/sources/candiboost.mjs — fold the Candiboost companies into the Radar.
 *
 * Reads the Candiboost pending rows and sends, looks each distinct spelling up by
 * name in a register (Zefix for Switzerland, SIRENE for France) and keeps one
 * verdict per spelling in data/candiboost-resolved.tsv, so a spelling is never
 * queried twice. Only `resolved` and `hand` rows become records. The candidate
 * settles an `ambiguous` row by filling `entity_id`, or places a public body by
 * filling `place`; the next run promotes that edit.
 *
 * The Candiboost tables and the register answers are untrusted data. The raw
 * cache is not used: the resolution file is the durable store.
 */

import { join } from 'node:path';
import {
  PENDING_COLUMNS, REGISTRY_COLUMNS, RESOLVED_COLUMNS, readTable, updateTable,
} from '../../lib/candiboost.mjs';
import { resolveZone } from '../zones.mjs';
import { NEEDLES_PER_QUERY, makeRegisterClient, needleFor, parseCandidates, resolveSpellings } from '../resolve.mjs';

const PENDING_SPEC = { key: 'company', columns: PENDING_COLUMNS };
const SENDS_SPEC = { key: 'thread_id', columns: REGISTRY_COLUMNS };
const RESOLVED_SPEC = { key: 'company', columns: RESOLVED_COLUMNS };
const PROMOTABLE = new Set(['ambiguous', 'out-of-zone', 'unresolved']);
const VERDICTS = ['resolved', 'hand', 'out-of-zone', 'ambiguous', 'unresolved'];

const text = (value) => String(value ?? '').trim();
const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const inZone = (table, site) => /^[A-D]$/.test(resolveZone(table, site).zone ?? '');

/**
 * Distinct Candiboost spellings with their domain: pending rows first, then
 * sends. Whitespace is collapsed, blank spellings are skipped, and the first
 * non-empty domain of a spelling wins.
 */
export function collectSpellings(pendingRows, sendRows) {
  const seen = new Map();
  for (const row of [...pendingRows, ...sendRows]) {
    const spelling = collapse(row.company);
    if (!spelling) continue;
    const domain = text(row.domain);
    if (!seen.has(spelling)) seen.set(spelling, { spelling, domain });
    else if (!seen.get(spelling).domain && domain) seen.get(spelling).domain = domain;
  }
  return [...seen.values()];
}

/**
 * Promote a hand edit of a non-final resolution row.
 *
 * @returns {null | {row: Record<string,string>, log: string|null}} `null` when the
 *   row is final or carries no edit; `log` is null when the row was promoted,
 *   otherwise it names why the edit was refused and `row` is the input row.
 */
export function promote(row, table) {
  if (!PROMOTABLE.has(row.verdict)) return null;
  const id = text(row.entity_id);
  const place = text(row.place);
  if (!id && !place) return null;
  const tag = `candiboost: ${row.company}`;
  if (id) {
    const listed = parseCandidates(row.candidates).find((c) => c.entityId === id);
    if (!listed) return { row, log: `${tag}: entity_id not among candidates` };
    const country = id.startsWith('siren:') ? 'FR' : 'CH';
    if (!inZone(table, { place: listed.place, postcode: listed.postcode, country })) {
      return { row, log: `${tag}: entity_id ${id} is out of zone` };
    }
    return {
      row: { ...row, verdict: 'resolved', country, legal_name: listed.legalName, entity_id: id, place: listed.place, postcode: listed.postcode },
      log: null,
    };
  }
  if (!inZone(table, { place, postcode: text(row.postcode), country: text(row.country) || undefined })) {
    return { row, log: `${tag}: place not in the zone table` };
  }
  return { row: { ...row, verdict: 'hand' }, log: null };
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export default {
  id: 'candiboost',
  family: 'campaign',
  auth: { kind: 'none', vars: [] },

  async *fetch(ctx) {
    const log = ctx.log ?? (() => {});
    const dir = join(ctx.dataRoot, 'data');
    const pending = readTable(join(dir, 'candiboost-pending.tsv'), PENDING_SPEC);
    const sends = readTable(join(dir, 'candiboost.tsv'), SENDS_SPEC);
    if (pending.missing && sends.missing) {
      log('candiboost: no Candiboost tables, nothing to resolve');
      return;
    }
    const resolvedPath = join(dir, 'candiboost-resolved.tsv');

    const have = new Set(readTable(resolvedPath, RESOLVED_SPEC).rows.map((r) => r.company));
    const todo = collectSpellings(pending.rows, sends.rows).filter((s) => !have.has(s.spelling));
    const batches = chunks(todo, NEEDLES_PER_QUERY);
    if (batches.length > 0) {
      const client = ctx.client ?? makeRegisterClient(ctx);
      for (const [i, batch] of batches.entries()) {
        const rows = await resolveSpellings(batch.map((s) => ({ ...s, needle: needleFor(s.spelling) })), { ...ctx, client });
        await updateTable(resolvedPath, RESOLVED_SPEC, (fresh) => {
          const known = new Set(fresh.rows.map((r) => r.company));
          return {
            columns: [...fresh.columns, ...RESOLVED_COLUMNS.filter((c) => !fresh.columns.includes(c))],
            rows: [...fresh.rows, ...rows.filter((r) => !known.has(r.company))],
          };
        });
        log(`candiboost: batch ${i + 1}/${batches.length} done`);
      }
    }

    let promoted = false;
    for (const row of readTable(resolvedPath, RESOLVED_SPEC).rows) {
      const result = promote(row, ctx.table);
      if (!result) continue;
      if (result.log) log(result.log);
      else promoted = true;
    }
    if (promoted) {
      await updateTable(resolvedPath, RESOLVED_SPEC, (fresh) => ({
        rows: fresh.rows.map((r) => promote(r, ctx.table)?.row ?? r),
      }));
    }

    const rows = readTable(resolvedPath, RESOLVED_SPEC).rows;
    const counts = Object.fromEntries(VERDICTS.map((v) => [v, rows.filter((r) => r.verdict === v).length]));
    log(`candiboost: resolved ${counts.resolved} · hand ${counts.hand} · out-of-zone ${counts['out-of-zone']} · ambiguous ${counts.ambiguous} · unresolved ${counts.unresolved}`);

    for (const row of rows) {
      if (row.verdict !== 'resolved' && row.verdict !== 'hand') continue;
      yield {
        name: text(row.legal_name) || row.company,
        legalName: text(row.legal_name) || undefined,
        aliases: [row.company],
        entityId: text(row.entity_id) || undefined,
        place: text(row.place),
        postcode: text(row.postcode),
        country: text(row.country) || undefined,
        sector: text(row.sector) || undefined,
        sizeBand: text(row.size_band) || '?',
        sourceId: 'candiboost',
        signalTokens: text(row.sector) === 'zefix-purpose:software' ? ['zefix:software'] : [],
      };
    }
  },
};
