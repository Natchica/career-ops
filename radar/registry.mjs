/**
 * radar/registry.mjs — read and write data/radar.tsv, the Prospect registry.
 *
 * Columns are addressed by header name, never by position, so a later stage can
 * append a column (a stage marker, a technical profile reference, a gate
 * verdict) without breaking the radar, and the radar preserves any column it
 * does not know. Cells use the reversible spreadsheet-formula escaping shared
 * with the other TSV files (lib/tsv-formula-escape.mjs).
 *
 * A missing file is an empty registry. A malformed one is an error the user can
 * act on, never an empty default: treating a parse error as "not there yet" is
 * how a user's file gets overwritten.
 */

import { readFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from '../scan.mjs';
import { escapeFormulaCell, unescapeFormulaCell } from '../lib/tsv-formula-escape.mjs';

export const RADAR_COLUMNS = Object.freeze([
  'key', 'name', 'aliases', 'sites', 'country', 'sector', 'size_band', 'signals',
  'sources', 'first_seen', 'last_seen', 'portals_ref', 'notes',
  'tier', 'tier_reason', 'tier_override', 'spontaneous', 'hints',
]);

const STALE_LOCK_MS = 30 * 60 * 1000;

export class RadarRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RadarRegistryError';
    if (code) this.code = code;
  }
}

export function registryPath(root) {
  return join(root, 'data', 'radar.tsv');
}

/**
 * @param {string} text
 * @returns {{columns: string[], rows: Record<string,string>[]}}
 * @throws {RadarRegistryError} on a missing key column, a duplicate key or a
 *   row whose cell count differs from the header
 */
export function parseRegistry(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { columns: [...RADAR_COLUMNS], rows: [] };

  const columns = lines[0].split('\t').map((c) => c.trim());
  if (!columns.includes('key')) throw new RadarRegistryError('header has no "key" column');
  if (new Set(columns).size !== columns.length) throw new RadarRegistryError('header repeats a column name');

  const rows = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = lines[i].split('\t');
    if (cells.length !== columns.length) {
      throw new RadarRegistryError(`line ${i + 1}: expected ${columns.length} cells, found ${cells.length}`);
    }
    const row = {};
    columns.forEach((name, c) => { row[name] = unescapeFormulaCell(cells[c]); });
    if (seen.has(row.key)) throw new RadarRegistryError(`line ${i + 1}: duplicate key "${row.key}"`);
    seen.add(row.key);
    rows.push(row);
  }
  return { columns, rows };
}

const cleanCell = (value) => escapeFormulaCell(String(value ?? '').replace(/[\t\r\n]+/g, ' '));

/** @param {{columns: string[], rows: Record<string,string>[]}} reg */
export function serializeRegistry({ columns, rows }) {
  const out = [columns.join('\t')];
  for (const row of rows) out.push(columns.map((c) => cleanCell(row[c])).join('\t'));
  return `${out.join('\n')}\n`;
}

/** @returns {{columns: string[], rows: Record<string,string>[], missing: boolean}} */
export function readRegistry(path) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { columns: [...RADAR_COLUMNS], rows: [], missing: true };
    throw new RadarRegistryError(`${path}: ${e.message}`);
  }
  try {
    return { ...parseRegistry(text), missing: false };
  } catch (e) {
    if (e instanceof RadarRegistryError) throw new RadarRegistryError(`${path}: ${e.message}`);
    throw e;
  }
}

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; }
      if (age <= STALE_LOCK_MS) {
        throw new RadarRegistryError(`another radar run is writing ${lockPath}; retry when it finishes`, 'ELOCKED');
      }
      try { unlinkSync(lockPath); } catch { /* another writer removed it first */ }
    }
  }
  throw new RadarRegistryError(`could not take the lock ${lockPath}`, 'ELOCKED');
}

/**
 * Write the registry atomically under an exclusive lock file. The text is built
 * before the lock is taken, so a serialization failure never touches the file.
 */
export async function writeRegistry(path, reg) {
  const text = serializeRegistry(reg);
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  acquireLock(lockPath);
  try {
    atomicWriteFile(path, text);
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/**
 * Read-modify-write under the lock: the registry is re-read after the lock is
 * taken, so a writer that finished during a long sweep is never overwritten with
 * rows read before it. `mutate` gets the fresh `{columns, rows}` and returns
 * `{columns?, rows, result?}`; a throw leaves the file untouched.
 *
 * @returns whatever `mutate` put in `result`
 */
export async function updateRegistry(path, mutate) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  acquireLock(lockPath);
  try {
    const fresh = readRegistry(path);
    const out = await mutate({ columns: fresh.columns, rows: fresh.rows });
    atomicWriteFile(path, serializeRegistry({ columns: out.columns ?? fresh.columns, rows: out.rows }));
    return out.result;
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
