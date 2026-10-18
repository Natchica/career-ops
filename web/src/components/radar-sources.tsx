"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2, Play, Save } from "lucide-react";
import { cn } from "@/lib/cn";
import { postNdjsonXhr } from "@/lib/post-ndjson-xhr.mjs";
import type { SourceInfo } from "@/lib/core/radar-run";

type Receipt = {
  mode: string;
  written: boolean;
  prospects: { new: number; known: number; total: number };
  sources: { id: string; status: string; reason: string | null; raw: number; zoned: number; unzoned: number }[];
  collisions: unknown[];
};
type RunState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; progress: string }
  | { phase: "previewed"; receipt: Receipt; token: string | null }
  | { phase: "saving"; startedAt: number; progress: string }
  | { phase: "saved"; receipt: Receipt }
  | { phase: "error"; message: string };

const FAMILY: Record<string, string> = {
  register: "Company register",
  ats: "Job boards and ATS",
  directory: "Startup directory",
  github: "GitHub organisations",
};

export function RadarSources({ defaultOpen }: { defaultOpen: boolean }) {
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [, setNow] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/radar/sources")
      .then((r) => r.json())
      .then((body) => (Array.isArray(body) ? setSources(body) : setLoadError(body?.error ?? "Could not list the sources.")))
      .catch(() => setLoadError("Could not reach the radar API."));
  }, []);

  const busy = Object.values(runs).some((r) => r.phase === "running" || r.phase === "saving");
  useEffect(() => {
    if (busy && !timer.current) timer.current = setInterval(() => setNow(Date.now()), 1000);
    if (!busy && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, [busy]);

  const set = (id: string, state: RunState) => setRuns((r) => ({ ...r, [id]: state }));

  async function start(id: string, path: "run" | "save", body: object, onResult: (receipt: Receipt, token: string | null) => RunState) {
    const startedAt = Date.now();
    const running = (progress: string): RunState => (path === "run" ? { phase: "running", startedAt, progress } : { phase: "saving", startedAt, progress });
    set(id, running("Starting…"));
    let settled = false;
    try {
      const { status, errorBody } = await postNdjsonXhr(`/api/radar/${path}`, body, (raw: object) => {
        const ev = raw as { type: string; message?: string; receipt?: Receipt; token?: string };
        if (ev.type === "progress" && ev.message) set(id, running(ev.message));
        if (ev.type === "error") {
          settled = true;
          set(id, { phase: "error", message: ev.message ?? "The run failed." });
        }
        if (ev.type === "result" && ev.receipt) {
          settled = true;
          set(id, onResult(ev.receipt, ev.token ?? null));
        }
      });
      if (status >= 400) set(id, { phase: "error", message: (errorBody as { error?: string } | null)?.error ?? `The server answered ${status}.` });
      else if (!settled) set(id, { phase: "error", message: "The run ended without a result." });
    } catch (e) {
      set(id, { phase: "error", message: e instanceof Error ? e.message : "Network error." });
    }
  }

  const preview = (id: string) => start(id, "run", { source: id }, (receipt, token) => ({ phase: "previewed", receipt, token }));
  const save = (id: string, token: string) => start(id, "save", { source: id, token }, (receipt) => ({ phase: "saved", receipt }));

  return (
    <details open={defaultOpen} className="group rounded-2xl border border-border bg-surface/40">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground">
        <span>Sources: fill the radar</span>
        <span className="text-xs font-normal text-faint group-open:hidden">show</span>
        <span className="hidden text-xs font-normal text-faint group-open:inline">hide</span>
      </summary>
      <div className="border-t border-border p-4">
        <p className="mb-4 max-w-2xl text-sm text-muted">
          Preview a source to see what it would add. Nothing is saved until you press Save on a preview you have seen.
        </p>
        {loadError && (
          <p role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400">{loadError}</p>
        )}
        {!sources && !loadError && <p className="text-sm text-faint">Loading sources…</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {sources?.map((s) => (
            <SourceCard key={s.id} source={s} run={runs[s.id] ?? { phase: "idle" }} busy={busy} onPreview={() => preview(s.id)} onSave={(token) => save(s.id, token)} onDiscard={() => set(s.id, { phase: "idle" })} />
          ))}
        </div>
      </div>
    </details>
  );
}

function SourceCard({ source, run, busy, onPreview, onSave, onDiscard }: {
  source: SourceInfo; run: RunState; busy: boolean; onPreview: () => void; onSave: (token: string) => void; onDiscard: () => void;
}) {
  const ready = source.auth === "ready";
  const working = run.phase === "running" || run.phase === "saving";
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-foreground">{source.id}</p>
          <p className="text-xs text-faint">{FAMILY[source.family] ?? source.family}</p>
        </div>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold", ready ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>
          {ready ? "Ready" : "Credentials missing"}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted">
        {source.lastSaved ? `Last saved ${source.lastSaved}` : "Never saved"}
        {!ready && <> · set <code className="text-foreground">{source.vars.join(", ")}</code></>}
      </p>

      {working && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted" aria-live="polite">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0">
            <span className="tabular-nums">{Math.round((Date.now() - run.startedAt) / 1000)} s</span> · <span className="break-words">{run.progress}</span>
          </span>
        </p>
      )}

      {run.phase === "previewed" && <PreviewResult receipt={run.receipt} source={source.id} token={run.token} busy={busy} onSave={onSave} onDiscard={onDiscard} />}

      {run.phase === "saved" && (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" aria-hidden="true" /> Saved: {run.receipt.prospects.total.toLocaleString()} prospects in the registry
          </p>
          <button type="button" onClick={() => window.location.reload()} className="mt-2 text-sm font-medium text-brand hover:underline">Show the list</button>
        </div>
      )}

      {run.phase === "error" && (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-muted">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" />
          <span className="break-words">{run.message}</span>
        </p>
      )}

      {!working && run.phase !== "previewed" && (
        <button
          type="button"
          onClick={onPreview}
          disabled={!ready || busy}
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          <Play className="size-3.5" aria-hidden="true" /> {run.phase === "idle" ? "Preview" : "Preview again"}
        </button>
      )}
    </div>
  );
}

function PreviewResult({ receipt, source, token, busy, onSave, onDiscard }: {
  receipt: Receipt; source: string; token: string | null; busy: boolean; onSave: (token: string) => void; onDiscard: () => void;
}) {
  const result = receipt.sources.find((s) => s.id === source);
  const failed = !result || result.status !== "ok";
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface/60 p-3 text-sm">
      {failed ? (
        <p role="alert" className="text-rose-700 dark:text-rose-400">
          {result?.status === "skipped" ? "Skipped" : "Failed"}: {result?.reason ?? "no result"}. Nothing can be saved from this run.
        </p>
      ) : (
        <>
          <p className="text-foreground">
            <span className="font-display text-2xl tabular-nums tracking-tight">{receipt.prospects.new.toLocaleString()}</span> new prospects
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            <li><span className="tabular-nums">{receipt.prospects.known.toLocaleString()}</span> already in the registry</li>
            <li><span className="tabular-nums">{result.raw.toLocaleString()}</span> records read, <span className="tabular-nums">{result.unzoned.toLocaleString()}</span> outside zones A to D</li>
            {receipt.collisions.length > 0 && <li><span className="tabular-nums">{receipt.collisions.length}</span> same-name firms with different register numbers kept apart</li>}
          </ul>
        </>
      )}
      <div className="mt-3 flex items-center gap-2">
        {!failed && token && (
          <button type="button" onClick={() => onSave(token)} disabled={busy} className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]">
            <Save className="size-3.5" aria-hidden="true" /> Save to registry
          </button>
        )}
        <button type="button" onClick={onDiscard} className="rounded-full px-3 py-1.5 text-sm text-muted hover:text-foreground">{failed ? "Dismiss" : "Discard"}</button>
      </div>
    </div>
  );
}
