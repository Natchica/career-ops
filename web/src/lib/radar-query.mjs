// Server-side filtering, sorting and paging for the Radar page.
//
// The registry (data/radar.tsv) can hold tens of thousands of Prospects. The
// browser only ever receives one page, so every rule that decides which rows
// appear lives here, in plain .mjs that `node --test` imports without a build.
// Rows are the registry's string cells, exactly as radar/registry.mjs parses
// them; this module never re-implements zone, identity or merge rules.

const SORTS = new Set(["name", "zone", "size_band", "signals", "first_seen"]);
const DEFAULT_DIR = { name: "asc", zone: "asc", size_band: "desc", signals: "desc", first_seen: "desc" };
const COUNTRIES = new Set(["CH", "FR", "DE"]);
const ZONE_LETTERS = ["A", "B", "C", "D"];
const BAND_RANK = new Map(
  ["?", "1-2", "3-5", "6-9", "10-19", "20-49", "50-99", "100-199", "200-249", "250-499", "500-999", "1000-1999", "2000-4999", "5000-9999", "10000+"]
    .map((band, rank) => [band, rank]),
);
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 100;

function intParam(raw, fallback) {
  const text = String(raw ?? "").trim();
  return /^-?\d+$/.test(text) ? Number(text) : fallback;
}

/**
 * Parse and sanitize the page's query string. Unknown or out-of-range values
 * fall back to a safe default; nothing here throws.
 *
 * @param {{get(name: string): string | null}} params
 */
export function parseRadarQuery(params) {
  const sortRaw = params.get("sort") ?? "";
  const sort = SORTS.has(sortRaw) ? sortRaw : "name";
  const dirRaw = params.get("dir");
  const zones = [];
  for (const part of String(params.get("zones") ?? "").split(",")) {
    const z = part.trim().toUpperCase();
    if (ZONE_LETTERS.includes(z) && !zones.includes(z)) zones.push(z);
  }
  const country = COUNTRIES.has(params.get("country") ?? "") ? params.get("country") : null;
  const since = /^\d{4}-\d{2}-\d{2}$/.test(params.get("since") ?? "") ? params.get("since") : null;
  return {
    page: Math.max(1, intParam(params.get("page"), 1)),
    pageSize: Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, intParam(params.get("pageSize"), PAGE_SIZE_DEFAULT))),
    sort,
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_DIR[sort],
    zones,
    country,
    source: (params.get("source") ?? "").trim().slice(0, 40) || null,
    sizeBand: (params.get("sizeBand") ?? "").trim().slice(0, 12) || null,
    minSignals: Math.min(4, Math.max(0, intParam(params.get("minSignals"), 0))),
    since,
    q: (params.get("q") ?? "").trim().slice(0, 80),
  };
}

const split = (cell) => String(cell ?? "").split(";").map((s) => s.trim()).filter(Boolean);

/** A registry row as the page shows it: lists split, register ids hidden, numbers real. */
export function toView(row) {
  const sites = split(row.sites).map((cell) => {
    const at = cell.lastIndexOf(":");
    return { place: cell.slice(0, at), zone: cell.slice(at + 1) };
  });
  return {
    key: row.key,
    name: row.name,
    aliases: split(row.aliases).filter((a) => !a.startsWith("#")),
    sites,
    zones: [...new Set(sites.map((s) => s.zone))].sort(),
    country: row.country,
    sector: row.sector,
    sizeBand: row.size_band || "?",
    signals: Number(row.signals) || 0,
    sources: split(row.sources),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    portalsRef: row.portals_ref && row.portals_ref !== "—" ? row.portals_ref : null,
    notes: row.notes ?? "",
  };
}

const fold = (text) => String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

function rowZones(row) {
  return split(row.sites).map((cell) => cell.slice(cell.lastIndexOf(":") + 1));
}

function matches(row, query, needle) {
  if (query.country && row.country !== query.country) return false;
  if (query.minSignals && (Number(row.signals) || 0) < query.minSignals) return false;
  if (query.sizeBand && (row.size_band || "?") !== query.sizeBand) return false;
  if (query.since && !(row.first_seen >= query.since)) return false;
  if (query.source && !split(row.sources).includes(query.source)) return false;
  if (query.zones.length) {
    const zones = rowZones(row);
    if (!query.zones.some((z) => zones.includes(z))) return false;
  }
  if (needle) {
    const hay = fold(`${row.name} ${split(row.aliases).filter((a) => !a.startsWith("#")).join(" ")} ${row.sites} ${row.sector}`);
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortKey(row, sort) {
  switch (sort) {
    case "signals": return Number(row.signals) || 0;
    case "size_band": return BAND_RANK.get(row.size_band || "?") ?? 0;
    case "first_seen": return row.first_seen ?? "";
    case "zone": return rowZones(row).sort()[0] ?? "Z";
    default: return String(row.name ?? "").toLowerCase();
  }
}

/**
 * One page of Prospects plus the counts the pager needs.
 *
 * @param {Record<string,string>[]} rows registry rows
 * @param {ReturnType<typeof parseRadarQuery>} query
 */
export function queryProspects(rows, query) {
  const needle = query.q ? fold(query.q) : "";
  const kept = [];
  for (const row of rows) if (matches(row, query, needle)) kept.push(row);

  const sign = query.dir === "asc" ? 1 : -1;
  const keyed = kept.map((row) => ({ row, k: sortKey(row, query.sort), n: String(row.name ?? "").toLowerCase() }));
  keyed.sort((a, b) => {
    if (a.k < b.k) return -sign;
    if (a.k > b.k) return sign;
    return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
  });

  const pageCount = Math.max(1, Math.ceil(keyed.length / query.pageSize));
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * query.pageSize;
  return {
    rows: keyed.slice(start, start + query.pageSize).map((x) => toView(x.row)),
    total: rows.length,
    filtered: keyed.length,
    page,
    pageSize: query.pageSize,
    pageCount,
  };
}

/**
 * Header numbers for the page. A Prospect with sites in two zones counts once in
 * each. "Latest run" is the most recent `last_seen`; "new" are the Prospects
 * first seen on that date.
 *
 * @param {Record<string,string>[]} rows
 */
export function summarize(rows) {
  const byZone = { A: 0, B: 0, C: 0, D: 0 };
  /** @type {Record<string, number>} */
  const byCountry = {};
  /** @type {Record<string, number>} */
  const bySource = {};
  let latestRun = null;
  for (const row of rows) {
    for (const z of new Set(rowZones(row))) if (z in byZone) byZone[z]++;
    for (const src of split(row.sources)) if (!src.includes(":")) bySource[src] = (bySource[src] ?? 0) + 1;
    if (row.country) byCountry[row.country] = (byCountry[row.country] ?? 0) + 1;
    if (row.last_seen && (latestRun === null || row.last_seen > latestRun)) latestRun = row.last_seen;
  }
  const newInLatestRun = latestRun === null ? 0 : rows.filter((r) => r.first_seen === latestRun).length;
  return { total: rows.length, byZone, byCountry, bySource, latestRun, newInLatestRun };
}

/**
 * The query string for a query object, leaving out every default so URLs stay
 * short and shareable. The inverse of {@link parseRadarQuery}.
 *
 * @param {Partial<ReturnType<typeof parseRadarQuery>>} query
 */
export function radarSearchString(query) {
  const params = new URLSearchParams();
  if (query.zones?.length) params.set("zones", query.zones.join(","));
  if (query.country) params.set("country", query.country);
  if (query.source) params.set("source", query.source);
  if (query.sizeBand) params.set("sizeBand", query.sizeBand);
  if (query.minSignals) params.set("minSignals", String(query.minSignals));
  if (query.since) params.set("since", query.since);
  if (query.q) params.set("q", query.q);
  const sort = query.sort ?? "name";
  if (sort !== "name") params.set("sort", sort);
  if (query.dir && query.dir !== DEFAULT_DIR[sort]) params.set("dir", query.dir);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  if (query.pageSize && query.pageSize !== PAGE_SIZE_DEFAULT) params.set("pageSize", String(query.pageSize));
  return params.toString();
}
