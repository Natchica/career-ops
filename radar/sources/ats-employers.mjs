/**
 * radar/sources/ats-employers.mjs — employers the scanners already saw.
 *
 * Reads data/scan-history.tsv, which every scanner appends to, and emits one raw
 * record per (company, distinct location text). Zoning happens downstream, in
 * the radar pipeline, from `locationText`: history locations are free text with
 * no postcodes (`STRASBOURG (67)`, `Switzerland - Zürich`, `Remote`).
 *
 * A company counts as having an ATS board when any of its rows came from a
 * `*-api` or `*-full` portal, the shape scan.mjs and scan-ats-full.mjs write.
 * That is evidence of a board, as opposed to a company merely seen in a feed,
 * and it is the only thing that raises the `ats` signal.
 *
 * Zero auth, zero network: the only input is a local file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScanHistoryLine, scanHistoryLineHasColumn } from '../../lib/scan-history-columns.mjs';

const BOARD_PORTAL = /-(api|full)$/;

function defaultHistoryPath(ctx) {
  if (ctx.historyPath) return ctx.historyPath;
  if (ctx.env?.CAREER_OPS_SCAN_HISTORY) return ctx.env.CAREER_OPS_SCAN_HISTORY;
  return join(ctx.dataRoot ?? process.cwd(), 'data', 'scan-history.tsv');
}

export default {
  id: 'ats-employers',
  family: 'ats',
  auth: { kind: 'none', vars: [] },

  async *fetch(ctx = {}) {
    const path = defaultHistoryPath(ctx);
    let text;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (e) {
      throw new Error(`cannot read scan-history.tsv at ${path}: ${e.code ?? e.message}`);
    }

    const lines = text.split('\n');
    // The header is written once when the file is created; legacy files have none.
    const start = /^\s*url\s*\t/i.test(lines[0] ?? '') ? 1 : 0;

    /** @type {Map<string, {name:string, board:boolean, firstPortal:string, locations:Map<string,string>}>} */
    const companies = new Map();
    for (let i = start; i < lines.length; i++) {
      if (!scanHistoryLineHasColumn(lines[i], 'status')) continue;
      const row = parseScanHistoryLine(lines[i]);
      const name = row.company.trim();
      if (!name) continue;
      const id = name.toLowerCase();
      if (!companies.has(id)) {
        companies.set(id, { name, board: false, firstPortal: row.portal.trim(), locations: new Map() });
      }
      const entry = companies.get(id);
      if (BOARD_PORTAL.test(row.portal.trim())) entry.board = true;
      const location = row.location.trim();
      if (!entry.locations.has(location)) entry.locations.set(location, row.portal.trim());
    }

    for (const entry of companies.values()) {
      for (const [location, portal] of entry.locations) {
        yield {
          name: entry.name,
          locationText: location,
          sourceId: 'ats-employers',
          boardSignal: entry.board,
          evidence: `scan-history:${portal}`,
        };
      }
    }
  },
};
