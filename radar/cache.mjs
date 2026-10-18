/**
 * radar/cache.mjs — disposable raw-record cache for the network sources.
 *
 * Units (a postcode, say) are stored after a successful sweep. A later run
 * replays a stored unit only when the cache is switched on (`--write` and
 * `--resume`) and the unit is under 24 hours old, so a preview followed by
 * `--write` does not sweep twice and an interrupted run resumes where it
 * stopped. Cache files hold only the records a source emitted, never an API
 * response body, so personal data a source drops never lands here.
 * Everything lives under data/cache/radar/ and is safe to delete.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TTL_MS = 24 * 3600 * 1000;

const safeName = (unit) => String(unit).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').slice(0, 80);

export function makeRawCache({ root, sourceId, useCache, now = Date.now }) {
  const dir = join(root, 'data', 'cache', 'radar', safeName(sourceId));
  const file = (unit) => join(dir, `${safeName(unit)}.json`);
  return {
    get(unit) {
      if (!useCache) return null;
      try {
        const stored = JSON.parse(readFileSync(file(unit), 'utf-8'));
        if (!Array.isArray(stored.records) || now() - stored.fetchedAt > TTL_MS) return null;
        return stored.records;
      } catch {
        return null;
      }
    },
    set(unit, records) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(unit), JSON.stringify({ fetchedAt: now(), records }));
    },
  };
}
