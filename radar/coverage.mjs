/**
 * radar/coverage.mjs — how complete is the radar?
 *
 * The baseline is every company career-ops already knows to be in a zone: the
 * employers in scan-history.tsv whose location resolves to zones A to D, plus
 * the tracked companies of portals.yml that the history can place. Recall is the
 * share of that baseline the registry holds.
 *
 * Two numbers, because one of them is flattering. The `ats-employers` source is
 * built from the same scan history as the baseline, so it finds every baseline
 * company by construction. `recall_excluding_ats_employers` counts only
 * registry rows another source also named, which is the real measure of the
 * registers, GitHub and the directories.
 *
 * Tracked companies the history cannot place are reported as `unzoned`, never
 * guessed into the baseline. The numbers are a floor, not a census: a company
 * nobody ever scanned is invisible to this check, which is why the radar exists.
 */

import { baseKey } from './identity.mjs';
import { zoneRecord } from './zones.mjs';

const NAMES_CAP = 200;
const UNZONED_CAP = 50;

const round = (n) => Math.round(n * 10_000) / 10_000;
const byName = (a, b) => a.localeCompare(b);

/**
 * @param {{
 *   records: {name: string, locationText?: string}[],
 *   portalsNames: string[],
 *   rows: {key: string, sources?: string}[],
 *   table: object,
 *   canon: (name: string) => string,
 * }} input
 */
export function computeCoverage({ records, portalsNames, rows, table, canon }) {
  const keyOf = (name) => baseKey(canon(name));

  /** @type {Map<string, string>} */
  const baseline = new Map();
  for (const record of records) {
    const key = keyOf(record.name);
    if (!key || baseline.has(key)) continue;
    if (zoneRecord(table, record).sites.length > 0) baseline.set(key, record.name.trim());
  }

  const unzoned = [];
  for (const name of portalsNames) {
    const key = keyOf(name);
    if (key && !baseline.has(key)) unzoned.push(name);
  }

  const all = new Set();
  const registers = new Set();
  for (const row of rows) {
    const key = String(row.key ?? '').split('|')[0];
    all.add(key);
    const others = String(row.sources ?? '').split(';').filter((s) => s && !s.startsWith('ats-employers'));
    if (others.length > 0) registers.add(key);
  }

  const missingFrom = (set) => [...baseline].filter(([key]) => !set.has(key)).map(([, name]) => name).sort(byName);
  const missing = missingFrom(all);
  const missingRegisters = missingFrom(registers);
  const recall = (missingList) => (baseline.size === 0 ? null : round((baseline.size - missingList.length) / baseline.size));

  return {
    baseline: {
      size: baseline.size,
      unzoned: unzoned.length,
      unzoned_names: unzoned.sort(byName).slice(0, UNZONED_CAP),
    },
    found: baseline.size - missing.length,
    recall_all: recall(missing),
    recall_excluding_ats_employers: recall(missingRegisters),
    missing: missing.slice(0, NAMES_CAP),
    missing_total: missing.length,
    missing_excluding_ats_employers: missingRegisters.slice(0, NAMES_CAP),
    missing_excluding_ats_employers_total: missingRegisters.length,
  };
}
