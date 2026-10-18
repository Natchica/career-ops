import { loadRadar } from "@/lib/core/radar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only view over data/radar.tsv. Next 16 route handlers take a plain
// Request (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md).
// Filtering, sorting and paging happen on the server in radar-query.mjs, so the
// browser receives one page of at most 100 rows however large the registry is.
// A missing registry answers 200 {state:"empty"}; a malformed one answers 409
// with the engine's message so the user can fix the file.

export async function GET(req: Request) {
  const result = await loadRadar(new URL(req.url).searchParams);
  if (result.state === "error") return Response.json(result, { status: 409 });
  return Response.json(result);
}
