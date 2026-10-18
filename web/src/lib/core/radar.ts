import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { createRadarLoader } from "@/lib/radar-load.mjs";
import { parseRadarQuery, queryProspects, summarize } from "@/lib/radar-query.mjs";

/**
 * Access layer for the company radar (web/AGENTS.md rule 1: orchestrate the
 * core, never reimplement it). The registry format, the file path and the
 * parser all come from the engine checkout's `radar/registry.mjs`, imported at
 * runtime from the code root. The checkout is chosen at runtime, so the path is
 * assembled here and the bundler is told not to trace it (the same reason
 * `rootScript()` builds its paths from a bare name).
 */

type EngineRegistry = {
  readRegistry: (file: string) => { rows: Record<string, string>[]; missing?: boolean };
  registryPath: (root: string) => string;
};

async function engineRegistry(): Promise<EngineRegistry> {
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  const file = path.join(/* turbopackIgnore: true */ codeRoot, "radar", "registry.mjs");
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(file).href)) as EngineRegistry;
}

const load = createRadarLoader({
  stat: (file: string) => fs.statSync(file),
  readRegistry: async (file: string) => (await engineRegistry()).readRegistry(file),
});

export type RadarResult =
  | { state: "empty" }
  | { state: "error"; message: string }
  | {
      state: "ok";
      summary: ReturnType<typeof summarize>;
      page: ReturnType<typeof queryProspects>;
      query: ReturnType<typeof parseRadarQuery>;
    };

/** One page of Prospects plus the header summary, for the given query string. */
export async function loadRadar(search: URLSearchParams): Promise<RadarResult> {
  const { registryPath } = await engineRegistry();
  const loaded = await load(registryPath(careerOpsRoot()));
  if (loaded.state !== "ok") return loaded as RadarResult;
  const query = parseRadarQuery(search);
  return { state: "ok", summary: summarize(loaded.rows), page: queryProspects(loaded.rows, query), query };
}
