import { spawn } from "node:child_process";
import { rootScript } from "@/lib/career-ops";
import { parseReceipt, progressMessage } from "@/lib/radar-stream.mjs";

/**
 * The process boundary for running the radar from the web (web/AGENTS.md rule 1:
 * orchestrate the core). Every run is `node radar.mjs ...` as a child process;
 * the rules for which arguments may be built live in radar-run.mjs, and what the
 * output means in radar-stream.mjs. This file only spawns, streams and cleans up.
 */

export type SourceInfo = {
  id: string;
  family: string;
  auth: "ready" | "missing-credentials" | "not-built";
  reason: string | null;
  vars: string[];
  lastSaved: string | null;
};

const g = globalThis as unknown as { __radarRunning?: boolean };

/** One run at a time. The registry lock also protects the file, this protects the machine. */
export const radarBusy = () => g.__radarRunning === true;

function runToCompletion(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [rootScript("radar"), ...argv], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The sources the engine knows, with auth state and last save. */
export async function listSources(): Promise<SourceInfo[]> {
  const { code, stdout, stderr } = await runToCompletion(["--sources"]);
  if (code !== 0) throw new Error(stderr.trim() || "radar.mjs --sources failed");
  return JSON.parse(stdout) as SourceInfo[];
}

type Extra = (receipt: Record<string, unknown>) => Record<string, unknown>;

/**
 * Run `radar.mjs` with the given, already validated argv and stream NDJSON:
 * `start`, `progress` lines from stderr, a `tick` every 5 seconds so the page
 * can show elapsed time, then one `result` (the receipt, plus whatever `extra`
 * adds) or one `error`. Closing the request kills the child.
 */
export function streamRadar(argv: string[], signal: AbortSignal, extra?: Extra): Response {
  if (radarBusy()) return Response.json({ error: "A radar run is already in progress." }, { status: 409 });
  g.__radarRunning = true;
  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: object) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(ticker);
        g.__radarRunning = false;
        controller.close();
      };

      const child = spawn(process.execPath, [rootScript("radar"), ...argv], { env: process.env });
      let stdout = "";
      let stderr = "";
      let carry = "";
      const ticker = setInterval(() => send({ type: "tick", elapsedMs: Date.now() - started }), 5000);

      send({ type: "start" });
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => {
        stderr += d;
        const lines = (carry + d).split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          const message = progressMessage(line);
          if (message) send({ type: "progress", message });
        }
      });
      child.on("error", (e) => {
        send({ type: "error", message: e.message });
        finish();
      });
      child.on("close", () => {
        const receipt = parseReceipt(stdout);
        if (receipt) send({ type: "result", receipt, ...(extra ? extra(receipt) : {}) });
        else send({ type: "error", message: (stderr.trim().split("\n").at(-1) || "The radar run produced no result.").slice(0, 300) });
        finish();
      });
      signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
        finish();
      });
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
