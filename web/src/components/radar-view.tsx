"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpDown, ChevronLeft, ChevronRight, CircleAlert, Search, Sparkles, Telescope } from "lucide-react";
import { CopyableCommand } from "@/components/copyable-command";
import { cn } from "@/lib/cn";
import type { RadarResult } from "@/lib/core/radar";
import { SIZE_BANDS, signalLevel, zoneTone, ZONE_TONES } from "@/lib/radar-presentation.mjs";
import { radarSearchString } from "@/lib/radar-query.mjs";

type Ok = Extract<RadarResult, { state: "ok" }>;
type Query = Ok["query"];

const ZONES = ["A", "B", "C", "D"] as const;
const SORT_LABEL: Record<string, string> = { name: "Company", zone: "Zone", size_band: "Size", signals: "Signals", first_seen: "First seen" };

const inputClass =
  "rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50";

export function RadarView({ initial, coverage }: { initial: RadarResult; coverage?: ReactNode }) {
  const [data, setData] = useState<RadarResult>(initial);
  const [query, setQuery] = useState<Query | null>(initial.state === "ok" ? initial.query : null);
  const [text, setText] = useState(initial.state === "ok" ? initial.query.q : "");
  const [loading, setLoading] = useState(false);
  const firstRender = useRef(true);

  // Search box: wait for a pause in typing before asking the server.
  useEffect(() => {
    if (!query || text === query.q) return;
    const timer = setTimeout(() => setQuery({ ...query, q: text, page: 1 }), 250);
    return () => clearTimeout(timer);
  }, [text, query]);

  // Any other change: ask the server for the matching page.
  const search = query ? radarSearchString(query) : null;
  useEffect(() => {
    if (search === null) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/radar${search ? `?${search}` : ""}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((body: RadarResult) => {
        setData(body);
        window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setData({ state: "error", message: "Could not reach the radar API." });
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [search]);

  if (data.state === "error") return <ErrorPanel message={data.message} />;
  if (data.state === "empty" || data.summary.total === 0) return <FirstRun />;
  if (!query) return <FirstRun />;

  const { summary, page } = data;
  const update = (patch: Partial<Query>) => setQuery({ ...query, ...patch, page: patch.page ?? 1 });
  const toggleZone = (z: string) => update({ zones: query.zones.includes(z) ? query.zones.filter((x: string) => x !== z) : [...query.zones, z] });
  const latestOnly = summary.latestRun !== null && query.since === summary.latestRun;
  const filtered = query.zones.length > 0 || !!query.country || !!query.source || !!query.sizeBand || query.minSignals > 0 || !!query.since || !!query.q;
  const clear = () => {
    setText("");
    setQuery({ ...query, zones: [], country: null, source: null, sizeBand: null, minSignals: 0, since: null, q: "", page: 1 });
  };
  const sortBy = (sort: string) =>
    update(query.sort === sort ? { sort, dir: query.dir === "asc" ? "desc" : "asc", page: 1 } : { sort, dir: undefined as never, page: 1 });

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Prospects</p>
          <p className="mt-1 font-display text-3xl tabular-nums tracking-tight text-landing">{summary.total.toLocaleString()}</p>
          <p className="mt-1 text-xs text-muted">employers in zones A to D</p>
        </div>
        {ZONES.map((z) => {
          const tone = ZONE_TONES[z];
          const active = query.zones.includes(z);
          return (
            <button
              key={z}
              type="button"
              aria-pressed={active}
              onClick={() => toggleZone(z)}
              title={tone.hint}
              className={cn(
                "rounded-2xl border p-4 text-left transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
                tone.card,
                active && "ring-2 ring-brand/60",
              )}
            >
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-faint">
                <span className={cn("grid size-5 place-items-center rounded-md text-[11px] font-bold", tone.chip)}>{tone.letter}</span>
                Zone {tone.letter}
              </p>
              <p className="mt-1 font-display text-3xl tabular-nums tracking-tight text-landing">{summary.byZone[z].toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted">{tone.label}</p>
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={latestOnly}
          disabled={summary.latestRun === null}
          onClick={() => update({ since: latestOnly ? null : summary.latestRun })}
          className={cn(
            "rounded-2xl border border-border bg-surface/40 p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
            latestOnly && "ring-2 ring-brand/60",
          )}
        >
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-faint">
            <Sparkles className="size-3.5 text-brand" aria-hidden="true" /> New
          </p>
          <p className="mt-1 font-display text-3xl tabular-nums tracking-tight text-landing">{summary.newInLatestRun.toLocaleString()}</p>
          <p className="mt-1 text-xs text-muted">in the latest run{summary.latestRun ? ` (${summary.latestRun})` : ""}</p>
        </button>
      </div>

      {coverage}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search companies</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search name, place or sector"
            className={cn(inputClass, "w-64 pl-9")}
          />
        </label>
        <select aria-label="Country" value={query.country ?? ""} onChange={(e) => update({ country: (e.target.value || null) as Query["country"] })} className={inputClass}>
          <option value="">All countries</option>
          <option value="CH">Switzerland</option>
          <option value="FR">France</option>
          <option value="DE">Germany</option>
        </select>
        <select aria-label="Source" value={query.source ?? ""} onChange={(e) => update({ source: e.target.value || null })} className={inputClass}>
          <option value="">All sources</option>
          {Object.keys(summary.bySource).sort().map((s) => (
            <option key={s} value={s}>{s} ({summary.bySource[s].toLocaleString()})</option>
          ))}
        </select>
        <select aria-label="Company size" value={query.sizeBand ?? ""} onChange={(e) => update({ sizeBand: e.target.value || null })} className={inputClass}>
          <option value="">Any size</option>
          {SIZE_BANDS.map((b: string) => (<option key={b} value={b}>{b === "?" ? "Size unknown" : `${b} staff`}</option>))}
        </select>
        <select aria-label="Technical signals" value={query.minSignals} onChange={(e) => update({ minSignals: Number(e.target.value) })} className={inputClass}>
          <option value={0}>Any signals</option>
          {[1, 2, 3, 4].map((n) => (<option key={n} value={n}>{n}+ signals</option>))}
        </select>
        {filtered && (
          <button type="button" onClick={clear} className="rounded-full px-3 py-1.5 text-sm font-medium text-brand hover:underline">
            Clear filters
          </button>
        )}
        <p className="ml-auto text-sm text-muted" aria-live="polite">
          <span className="tabular-nums text-foreground">{page.filtered.toLocaleString()}</span> of{" "}
          <span className="tabular-nums">{page.total.toLocaleString()}</span> prospects
        </p>
      </div>

      <div className={cn("mt-4 overflow-x-auto rounded-2xl border border-border bg-surface/40 transition-opacity", loading && "opacity-60")}>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Prospects in commute zones A to D</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-faint">
            <tr>
              {(["name", "zone", "size_band", "signals", "first_seen"] as const).map((col) => (
                <th
                  key={col}
                  scope="col"
                  aria-sort={query.sort === col ? (query.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={cn("px-4 py-2.5 font-medium", (col === "size_band" || col === "first_seen") && "hidden md:table-cell")}
                >
                  <button type="button" onClick={() => sortBy(col)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground">
                    {SORT_LABEL[col]}
                    <ArrowUpDown className={cn("size-3", query.sort === col ? "text-brand" : "opacity-40")} aria-hidden="true" />
                  </button>
                </th>
              ))}
              <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">Sources</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {page.rows.map((row) => {
              const level = signalLevel(row.signals);
              return (
                <tr key={row.key} className="align-top">
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-foreground">{row.name}</p>
                    <p className="text-xs text-faint">
                      {row.country}
                      {row.sector ? ` · ${row.sector}` : ""}
                      {row.portalsRef ? " · already tracked" : ""}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {row.sites.slice(0, 4).map((site: { place: string; zone: string }) => (
                        <span key={`${site.place}:${site.zone}`} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", zoneTone(site.zone).chip)}>
                          <span className="font-bold">{zoneTone(site.zone).letter}</span>
                          {site.place}
                        </span>
                      ))}
                      {row.sites.length > 4 && <span className="text-[11px] text-faint">+{row.sites.length - 4} more</span>}
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 tabular-nums text-muted md:table-cell">{row.sizeBand === "?" ? "unknown" : row.sizeBand}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5" title={level.description}>
                      <span className="flex gap-0.5" aria-hidden="true">
                        {Array.from({ length: level.total }, (_, i) => (
                          <span key={i} className={cn("size-2 rounded-full", i < level.filled ? "bg-brand" : "bg-border")} />
                        ))}
                      </span>
                      <span className="text-xs tabular-nums text-muted">{level.label}</span>
                      <span className="sr-only">{level.description}</span>
                    </span>
                  </td>
                  <td className="hidden px-4 py-2.5 tabular-nums text-muted md:table-cell">{row.firstSeen}</td>
                  <td className="hidden px-4 py-2.5 lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {row.sources.filter((s: string) => !s.includes(":")).map((s: string) => (
                        <span key={s} className="rounded bg-border/60 px-1.5 py-0.5 text-[11px] text-muted">{s}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {page.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">
                  No prospect matches these filters.{" "}
                  <button type="button" onClick={clear} className="font-medium text-brand hover:underline">Clear filters</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <nav aria-label="Pages" className="mt-4 flex items-center justify-between">
        <button
          type="button"
          disabled={page.page <= 1}
          onClick={() => setQuery({ ...query, page: page.page - 1 })}
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden="true" /> Previous
        </button>
        <p className="text-sm text-muted">
          Page <span className="tabular-nums text-foreground">{page.page}</span> of <span className="tabular-nums">{page.pageCount}</span>
        </p>
        <button
          type="button"
          disabled={page.page >= page.pageCount}
          onClick={() => setQuery({ ...query, page: page.page + 1 })}
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground disabled:opacity-40"
        >
          Next <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </nav>
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div role="alert" className="flex gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm">
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" />
      <div>
        <p className="font-medium text-rose-700 dark:text-rose-400">The radar registry cannot be read</p>
        <p className="mt-1 text-muted">
          Nothing is shown as empty, so nothing gets overwritten. Fix <code className="text-foreground">data/radar.tsv</code> and reload.
        </p>
        <p className="mt-2 break-all font-mono text-xs text-faint">{message}</p>
      </div>
    </div>
  );
}

function FirstRun() {
  const families = [
    { name: "Company registers", text: "French employers by postcode (SIRENE), and Swiss firms whose registered purpose is software (Zefix)." },
    { name: "Job-board and ATS mining", text: "Employers your scanners already met, with hiring-board evidence." },
    { name: "Startup directories", text: "Regional startup and cluster lists, where their terms allow it." },
    { name: "GitHub organisations", text: "Engineering-heavy firms that list a place in a zone." },
  ];
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/30 p-6">
      <div className="flex items-center gap-2">
        <Telescope className="size-5 text-brand" aria-hidden="true" />
        <h2 className="font-display text-lg tracking-tight text-landing">Your radar is empty</h2>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        The radar lists every employer with a site in your commute zones A to D, from four kinds of source. It only names
        companies. Nothing is evaluated, filtered or contacted. Press Preview on a source above, which writes nothing,
        then Save once you like what you see. Prefer a terminal? The same preview is:
      </p>
      <CopyableCommand command="node radar.mjs --source ats-employers --summary" className="mt-4 max-w-xl" />
      <p className="mt-3 text-sm text-muted">
        Add <code className="text-foreground">--write</code> to save it, then reload this page.
      </p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {families.map((f) => (
          <li key={f.name} className="rounded-xl border border-border bg-surface/40 p-3">
            <p className="text-sm font-medium text-foreground">{f.name}</p>
            <p className="mt-0.5 text-xs text-muted">{f.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
