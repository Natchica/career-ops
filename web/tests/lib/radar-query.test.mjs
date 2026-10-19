import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRadarQuery, queryProspects, summarize, toView, radarSearchString } from "../../src/lib/radar-query.mjs";

const row = (over = {}) => ({
  key: "acme", name: "Acme", aliases: "#siren:1;ACME SAS", sites: "Basel:B;Zurich:C", country: "CH", sector: "62.01Z",
  size_band: "20-49", signals: "2", sources: "sirene;github-orgs", first_seen: "2026-10-18", last_seen: "2026-10-18",
  portals_ref: "—", notes: "", ...over,
});
const q = (text = "") => parseRadarQuery(new URLSearchParams(text));

test("defaults: page 1, 50 per page, name ascending, no filters", () => {
  const query = q();
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 50);
  assert.equal(query.sort, "name");
  assert.equal(query.dir, "asc");
  assert.deepEqual(query.zones, []);
  assert.equal(query.minSignals, 0);
});

test("page size is clamped to 10..100 and bad numbers fall back", () => {
  assert.equal(q("pageSize=1000").pageSize, 100);
  assert.equal(q("pageSize=1").pageSize, 10);
  assert.equal(q("pageSize=abc").pageSize, 50);
  assert.equal(q("page=0").page, 1);
  assert.equal(q("page=-4").page, 1);
});

test("sort is whitelisted and unknown values fall back to name", () => {
  assert.equal(q("sort=signals").sort, "signals");
  assert.equal(q("sort=signals").dir, "desc");
  assert.equal(q("sort=first_seen&dir=asc").dir, "asc");
  assert.equal(q("sort=__proto__").sort, "name");
  assert.equal(q("sort=notes").sort, "name");
});

test("zone, country and signal filters accept only valid values", () => {
  assert.deepEqual(q("zones=A,c,Z,B").zones, ["A", "C", "B"]);
  assert.equal(q("country=CH").country, "CH");
  assert.equal(q("country=US").country, null);
  assert.equal(q("minSignals=3").minSignals, 3);
  assert.equal(q("minSignals=9").minSignals, 4);
  assert.equal(q("since=2026-10-01").since, "2026-10-01");
  assert.equal(q("since=yesterday").since, null);
});

test("a view splits sites and sources, hides register ids, and reads signals as a number", () => {
  const view = toView(row());
  assert.deepEqual(view.sites, [{ place: "Basel", zone: "B" }, { place: "Zurich", zone: "C" }]);
  assert.deepEqual(view.zones, ["B", "C"]);
  assert.deepEqual(view.sources, ["sirene", "github-orgs"]);
  assert.deepEqual(view.aliases, ["ACME SAS"]);
  assert.equal(view.signals, 2);
});

test("filters combine: zone, country, source, size band, signals, text", () => {
  const rows = [
    row({ key: "a", name: "Alpha", sites: "Colmar:A", country: "FR", signals: "0", sources: "sirene", size_band: "3-5" }),
    row({ key: "b", name: "Beta", sites: "Basel:B", country: "CH", signals: "3", sources: "github-orgs", size_band: "100-199" }),
    row({ key: "c", name: "Gamma", sites: "Zurich:C", country: "CH", signals: "1", sources: "sirene", size_band: "20-49" }),
  ];
  assert.deepEqual(queryProspects(rows, q("zones=B,C")).rows.map((r) => r.key), ["b", "c"]);
  assert.deepEqual(queryProspects(rows, q("country=FR")).rows.map((r) => r.key), ["a"]);
  assert.deepEqual(queryProspects(rows, q("source=github-orgs")).rows.map((r) => r.key), ["b"]);
  assert.deepEqual(queryProspects(rows, q("sizeBand=20-49")).rows.map((r) => r.key), ["c"]);
  assert.deepEqual(queryProspects(rows, q("minSignals=1")).rows.map((r) => r.key), ["b", "c"]);
  assert.deepEqual(queryProspects(rows, q("q=gam")).rows.map((r) => r.key), ["c"]);
  assert.deepEqual(queryProspects(rows, q("q=basel")).rows.map((r) => r.key), ["b"], "text also matches sites");
  assert.deepEqual(queryProspects(rows, q("zones=B&country=FR")).rows, []);
});

test("sorting by signals and size band is stable and respects direction", () => {
  const rows = [
    row({ key: "a", name: "Alpha", signals: "1", size_band: "?" }),
    row({ key: "b", name: "Beta", signals: "3", size_band: "100-199" }),
    row({ key: "c", name: "Gamma", signals: "3", size_band: "3-5" }),
  ];
  assert.deepEqual(queryProspects(rows, q("sort=signals")).rows.map((r) => r.key), ["b", "c", "a"]);
  assert.deepEqual(queryProspects(rows, q("sort=size_band")).rows.map((r) => r.key), ["b", "c", "a"]);
  assert.deepEqual(queryProspects(rows, q("sort=size_band&dir=asc")).rows.map((r) => r.key), ["a", "c", "b"]);
});

test("paging returns the right slice and counts", () => {
  const rows = Array.from({ length: 125 }, (_, i) => row({ key: `k${String(i).padStart(3, "0")}`, name: `Company ${String(i).padStart(3, "0")}` }));
  const page3 = queryProspects(rows, q("page=3&pageSize=50"));
  assert.equal(page3.rows.length, 25);
  assert.equal(page3.total, 125);
  assert.equal(page3.filtered, 125);
  assert.equal(page3.pageCount, 3);
  assert.equal(page3.rows[0].key, "k100");
  const beyond = queryProspects(rows, q("page=99&pageSize=50"));
  assert.equal(beyond.page, 3, "a page past the end is clamped to the last page");
});

test("pageSize=1000 never returns more than 100 rows", () => {
  const rows = Array.from({ length: 300 }, (_, i) => row({ key: `k${i}`, name: `C${i}` }));
  assert.equal(queryProspects(rows, q("pageSize=1000")).rows.length, 100);
});

test("summary counts prospects per zone and country, and new ones in the latest run", () => {
  const rows = [
    row({ key: "a", sites: "Colmar:A", country: "FR", first_seen: "2026-10-01", last_seen: "2026-10-18" }),
    row({ key: "b", sites: "Basel:B;Zurich:C", country: "CH", first_seen: "2026-10-18", last_seen: "2026-10-18" }),
    row({ key: "c", sites: "Zug:D", country: "CH", first_seen: "2026-10-18", last_seen: "2026-10-18" }),
  ];
  const s = summarize(rows);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byZone, { A: 1, B: 1, C: 1, D: 1 });
  assert.deepEqual(s.byCountry, { CH: 2, FR: 1 });
  assert.equal(s.latestRun, "2026-10-18");
  assert.equal(s.newInLatestRun, 2);
});

test("summary of an empty registry is all zeros", () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.deepEqual(s.byZone, { A: 0, B: 0, C: 0, D: 0 });
  assert.equal(s.latestRun, null);
  assert.equal(s.newInLatestRun, 0);
});

test("50k rows filter, sort and page in under 200 ms", () => {
  const places = ["Colmar:A", "Basel:B", "Zurich:C", "Zug:D"];
  const rows = Array.from({ length: 50_000 }, (_, i) =>
    row({ key: `k${i}`, name: `Company ${i}`, sites: places[i % 4], signals: String(i % 5), size_band: i % 2 ? "20-49" : "?" }));
  const started = process.cpuUsage();
  const result = queryProspects(rows, q("zones=B,C&minSignals=1&sort=signals&page=3"));
  const used = process.cpuUsage(started);
  const ms = (used.user + used.system) / 1000;
  console.log(`radar 50k query: ${Math.round(ms)} ms cpu`);
  assert.equal(result.rows.length, 50);
  assert.ok(ms < 200, `took ${ms} ms of cpu`);
});

test("summary counts prospects per source and ignores the internal board marker", () => {
  const rows = [
    row({ key: "a", sources: "sirene;ats-employers;ats-employers:board" }),
    row({ key: "b", sources: "sirene" }),
    row({ key: "c", sources: "github-orgs" }),
  ];
  assert.deepEqual(summarize(rows).bySource, { "ats-employers": 1, "github-orgs": 1, sirene: 2 });
});

test("the search string builder emits only non-default values and round-trips through the parser", () => {
  assert.equal(radarSearchString({}), "");
  const query = { zones: ["B", "C"], country: "CH", source: "sirene", sizeBand: "20-49", minSignals: 2, since: "2026-10-01", tier: null, state: null, q: "acme ag", sort: "signals", dir: "asc", page: 3, pageSize: 25 };
  const text = radarSearchString(query);
  const parsed = parseRadarQuery(new URLSearchParams(text));
  assert.deepEqual(parsed, query);
  assert.equal(radarSearchString({ page: 1, pageSize: 50, sort: "name", dir: "asc" }), "");
});
