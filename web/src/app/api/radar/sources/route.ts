import { listSources } from "@/lib/core/radar-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The engine's own list of sources with auth state and last save, from
// `radar.mjs --sources`. The page never re-derives credential rules.
export async function GET() {
  try {
    return Response.json(await listSources());
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not list sources" }, { status: 500 });
  }
}
