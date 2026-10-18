import { Telescope } from "lucide-react";
import { RadarCoverage } from "@/components/radar-coverage";
import { RadarSources } from "@/components/radar-sources";
import { RadarView } from "@/components/radar-view";
import { loadRadar } from "@/lib/core/radar";

export const dynamic = "force-dynamic";

// Next 16: `searchParams` is a Promise
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
export default async function RadarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }
  const initial = await loadRadar(params);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-center gap-3">
        <Telescope className="size-6 text-brand" aria-hidden="true" />
        <h1 className="font-display text-2xl tracking-tight text-landing">Radar</h1>
      </div>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        Every employer with a site in your commute zones, whether or not it is hiring. The radar only names companies:
        nothing here is scored, screened or contacted yet.
      </p>
      <p className="mt-1.5 text-xs text-faint">
        Backed by <code className="text-muted">data/radar.tsv</code>, built by <code className="text-muted">radar.mjs</code>. Local only.
      </p>
      <div className="mt-6">
        <RadarSources defaultOpen={initial.state !== "ok" || initial.summary.total === 0} />
      </div>
      <div className="mt-6">
        <RadarView initial={initial} coverage={<RadarCoverage />} />
      </div>
    </div>
  );
}
