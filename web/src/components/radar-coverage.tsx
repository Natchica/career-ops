"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import type { CoverageReport } from "@/lib/core/radar-run";
import { coverageView } from "@/lib/radar-presentation.mjs";

/**
 * "Is the list complete?" Recall against the companies career-ops already knows
 * to be in your zones. It is a floor: a company nobody ever scanned is
 * invisible to it, which is the reason the radar exists.
 */
export function RadarCoverage() {
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/radar/coverage")
      .then((r) => r.json())
      .then((body) => (body?.error ? setError(body.error) : setReport(body)))
      .catch(() => setError("Could not reach the radar API."));
  }, []);

  if (error) {
    return (
      <p role="alert" className="mt-5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-muted">
        Completeness could not be measured: <span className="break-all font-mono text-xs text-faint">{error}</span>
      </p>
    );
  }
  if (!report) return <div className="mt-5 h-24 animate-pulse rounded-2xl border border-border bg-surface/40" aria-label="Measuring completeness" />;

  const view = coverageView(report);
  return (
    <section aria-label="Completeness" className="mt-5 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-foreground">Is the list complete?</h2>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", view.chip)}>{view.verdict}</span>
      </div>
      <p className="mt-2 text-sm text-foreground">{view.headline}</p>
      {view.percent !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
          aria-label="Share of known in-zone companies already in the radar"
          className="mt-3 h-2.5 overflow-hidden rounded-full bg-border"
        >
          <div className={cn("h-full rounded-full", view.bar)} style={{ width: `${view.percent}%` }} />
        </div>
      )}
      <ul className="mt-3 space-y-1 text-xs text-muted">
        {view.registersPercent !== null && (
          <li>
            Registers and other sources alone: <span className="tabular-nums text-foreground">{view.registersPercent}%</span>. This is the honest
            figure, because the job-board source is built from the same scan history as the measure.
          </li>
        )}
        {view.unzoned > 0 && (
          <li>
            <span className="tabular-nums">{view.unzoned}</span> tracked companies have no known location, so they are not in the measure.
          </li>
        )}
        <li>A floor, not a ceiling: a company nobody ever scanned cannot show up here.</li>
      </ul>
      {view.missingTotal > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-brand">
            Show the {view.missingTotal.toLocaleString()} known companies not in the radar yet
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {report.missing.join(" · ")}
            {report.missing_total > report.missing.length && ` · and ${(report.missing_total - report.missing.length).toLocaleString()} more`}
          </p>
        </details>
      )}
    </section>
  );
}
