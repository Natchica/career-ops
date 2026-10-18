import { listSources, streamRadar } from "@/lib/core/radar-run";
import { readJsonObject } from "@/lib/json-body";
import { planSave, sharedRunTokens } from "@/lib/radar-run.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// The only web route that reaches `radar.mjs --write`. It answers 403 unless the
// body carries the single-use token a clean preview of the same source and zones
// earned, so nothing is saved that the user did not first see. The write reuses
// the sweep cached by that preview (under 24 hours old), so it is normally quick.
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });

  let sources;
  try {
    sources = await listSources();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not list sources" }, { status: 500 });
  }
  const plan = planSave(body, sources.map((s) => s.id), sharedRunTokens());
  if (!plan.ok) return Response.json({ error: plan.error }, { status: plan.status });
  return streamRadar(plan.argv, req.signal);
}
