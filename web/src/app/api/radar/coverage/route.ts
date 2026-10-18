import { getCoverage } from "@/lib/core/radar-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How complete the radar is, from `radar.mjs --coverage`: recall against the
// companies career-ops already knows to be in a zone. The page never computes
// it itself, so the CLI and the page cannot disagree.
export async function GET() {
  try {
    return Response.json(await getCoverage());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not compute coverage" }, { status: 500 });
  }
}
