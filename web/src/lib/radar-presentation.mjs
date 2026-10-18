// Colour and label tokens for the Radar page.
//
// Colour never carries meaning alone: every zone has a letter and a text label,
// every signal level has an "n/4" label. Class strings are written out in full
// so Tailwind sees them, and each has a dark-mode variant in the style of
// portals-view.tsx.

export const ZONE_TONES = {
  A: {
    letter: "A",
    label: "Daily commute",
    hint: "Colmar, Mulhouse, Sélestat: 35 minutes or less",
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    card: "border-emerald-500/30 bg-emerald-500/5",
  },
  B: {
    letter: "B",
    label: "Trinational area",
    hint: "Basel, Strasbourg, Freiburg, Belfort: 35 to 75 minutes",
    dot: "bg-sky-500",
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    card: "border-sky-500/30 bg-sky-500/5",
  },
  C: {
    letter: "C",
    label: "Zurich corridor",
    hint: "Zurich, Olten, Aarau, Solothurn: hybrid only",
    dot: "bg-amber-500",
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    card: "border-amber-500/30 bg-amber-500/5",
  },
  D: {
    letter: "D",
    label: "Zug, Lucerne, Bern",
    hint: "Two hours or more: hybrid with strong pay only",
    dot: "bg-violet-500",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
    card: "border-violet-500/30 bg-violet-500/5",
  },
};

const UNKNOWN_TONE = {
  letter: "?",
  label: "Unknown zone",
  hint: "This place is not in the zone table",
  dot: "bg-zinc-400",
  chip: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  card: "border-zinc-500/30 bg-zinc-500/5",
};

export function zoneTone(zone) {
  return ZONE_TONES[zone] ?? UNKNOWN_TONE;
}

const SIGNAL_TEXT = [
  "No technical signal yet",
  "One technical signal",
  "Two technical signals",
  "Three technical signals",
  "Four technical signals",
];

/** Signal strength 0 to 4 as dots plus a text label. A count, never a verdict. */
export function signalLevel(value) {
  const n = Math.min(4, Math.max(0, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0));
  return { filled: n, total: 4, label: `${n}/4`, description: SIGNAL_TEXT[n] };
}

export const SIZE_BANDS = [
  "?", "1-2", "3-5", "6-9", "10-19", "20-49", "50-99", "100-199", "200-249", "250-499",
  "500-999", "1000-1999", "2000-4999", "5000-9999", "10000+",
];

const COVERAGE_TONES = {
  good: {
    verdict: "Nearly complete",
    bar: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  ok: {
    verdict: "Partly there",
    bar: "bg-amber-500",
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  low: {
    verdict: "Just starting",
    bar: "bg-rose-500",
    chip: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  },
};

/**
 * What the completeness gauge shows, from `radar.mjs --coverage`. The percentage
 * is recall against companies career-ops already knows to be in a zone, so it is
 * a floor: a company nobody ever scanned is invisible to it. A verdict in words
 * always accompanies the colour.
 */
export function coverageView(coverage) {
  const size = coverage.baseline.size;
  const toPercent = (r) => (r === null || r === undefined ? null : Math.round(r * 100));
  const percent = toPercent(coverage.recall_all);
  const base = {
    percent,
    registersPercent: toPercent(coverage.recall_excluding_ats_employers),
    missingTotal: coverage.missing_total,
    registersMissingTotal: coverage.missing_excluding_ats_employers_total,
    unzoned: coverage.baseline.unzoned,
    baselineSize: size,
  };
  if (percent === null) {
    return { ...base, tone: "low", ...COVERAGE_TONES.low, verdict: "No baseline yet", headline: "No baseline yet", bar: "bg-zinc-400", chip: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300" };
  }
  // The verdict follows the honest measure: the registers and other sources,
  // since the job-board source is built from the same history as the baseline.
  const basis = base.registersPercent ?? percent;
  const tone = basis >= 90 ? "good" : basis >= 50 ? "ok" : "low";
  return {
    ...base,
    tone,
    ...COVERAGE_TONES[tone],
    headline: `${percent}% of the ${size} companies you already know in your zones`,
  };
}
