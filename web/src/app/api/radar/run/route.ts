import { listSources, streamRadar } from "@/lib/core/radar-run";
import { readJsonObject } from "@/lib/json-body";
import { planPreview, sharedRunTokens } from "@/lib/radar-run.mjs";
import { earnsToken } from "@/lib/radar-stream.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Preview a source: `radar.mjs --source <id> --json`, never --write. The
// request body is validated against the engine's own source list, and a clean
// preview earns a single-use token that the save route requires.
export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });

  let sources;
  try {
    sources = await listSources();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not list sources" }, { status: 500 });
  }
  const plan = planPreview(body, sources.map((s) => s.id));
  if (!plan.ok) return Response.json({ error: plan.error }, { status: plan.status });

  const source = sources.find((s) => s.id === plan.params.source);
  if (source?.auth === "missing-credentials") {
    return Response.json({ error: `Missing credentials: set ${source.vars.join(", ")} first.` }, { status: 400 });
  }
  return streamRadar(plan.argv, req.signal, (receipt) =>
    earnsToken(receipt, plan.params.source) ? { token: sharedRunTokens().issue(plan.params) } : {},
  );
}
