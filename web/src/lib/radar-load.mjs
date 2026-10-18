// Loads the Radar registry for the page, parsing it again only when the file
// changed. The parse itself is the engine's (radar/registry.mjs), injected as
// `readRegistry`, so the web never owns a second copy of the format.
//
// A missing file is an empty registry. A malformed one is an error state that
// carries the engine's message, never an empty default, so a broken user file
// stays visible. Failures are not cached. Any other failure is a bug and is
// rethrown rather than dressed up as a state.

/**
 * @param {{
 *   stat: (path: string) => {mtimeMs: number, size: number},
 *   readRegistry: (path: string) => Promise<{rows: Record<string,string>[], missing?: boolean}> | {rows: Record<string,string>[], missing?: boolean},
 * }} deps
 */
export function createRadarLoader({ stat, readRegistry }) {
  let cached = null;

  return async function load(path) {
    let stamp;
    try {
      stamp = stat(path);
    } catch (e) {
      if (e?.code === "ENOENT") return { state: "empty" };
      throw e;
    }
    if (cached && cached.path === path && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
      return { state: "ok", rows: cached.rows };
    }
    try {
      const registry = await readRegistry(path);
      if (registry.missing) return { state: "empty" };
      cached = { path, mtimeMs: stamp.mtimeMs, size: stamp.size, rows: registry.rows };
      return { state: "ok", rows: registry.rows };
    } catch (e) {
      if (e?.name === "RadarRegistryError") return { state: "error", message: e.message };
      throw e;
    }
  };
}
