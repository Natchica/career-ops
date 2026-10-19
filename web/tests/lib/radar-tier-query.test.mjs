import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRadarQuery, queryProspects, summarize, toView, radarSearchString, spontaneousStateOf,
} from "../../src/lib/radar-query.mjs";
// The web never imports the engine at build time; a test may, to hold the copies in step.
import { classify, loadTierRules, parseSpontaneous } from "../../../radar/tiers.mjs";

const row = (over = {}) => ({
  key: "acme", name: "Acme", aliases: "", sites: "Colmar:A", country: "FR", sector: "62.01Z",
  size_band: "10-19", signals: "1", sources: "sirene", first_seen: "2026-10-18", last_seen: "2026-10-18",
  portals_ref: "—", notes: "", tier: "", tier_reason: "", tier_override: "", spontaneous: "", ...over,
});
const q = (text = "") => parseRadarQuery(new URLSearchParams(text));

test("tier and state are whitelisted and anything else is dropped", () => {
  assert.equal(q("tier=1").tier, "1");
  assert.equal(q("tier=out").tier, "out");
  assert.equal(q("tier=none").tier, "none");
  assert.equal(q("tier=9").tier, null);
  assert.equal(q("tier=__proto__").tier, null);
  assert.equal(q("state=drafted").state, "drafted");
  assert.equal(q("state=invalid").state, null);
  assert.equal(q().tier, null);
  assert.equal(q().state, null);
});

test("the tier filter treats an empty cell as none", () => {
  const rows = [row({ key: "a", tier: "1" }), row({ key: "b", tier: "2" }), row({ key: "c", tier: "" }), row({ key: "d", tier: "out" })];
  const keysOf = (text) => queryProspects(rows, q(text)).rows.map((p) => p.key).sort();
  assert.deepEqual(keysOf("tier=1"), ["a"]);
  assert.deepEqual(keysOf("tier=none"), ["c"]);
  assert.deepEqual(keysOf("tier=out"), ["d"]);
  assert.deepEqual(keysOf(""), ["a", "b", "c", "d"]);
});

test("the state filter reads the spontaneous cell", () => {
  const rows = [
    row({ key: "a", spontaneous: "" }),
    row({ key: "b", spontaneous: "drafted:2026-10-20" }),
    row({ key: "c", spontaneous: "sent:2026-10-21:#7" }),
    row({ key: "d", spontaneous: "skipped:2026-10-20:no info" }),
  ];
  const keysOf = (text) => queryProspects(rows, q(text)).rows.map((p) => p.key);
  assert.deepEqual(keysOf("state=none"), ["a"]);
  assert.deepEqual(keysOf("state=drafted"), ["b"]);
  assert.deepEqual(keysOf("state=sent"), ["c"]);
  assert.deepEqual(keysOf("state=skipped"), ["d"]);
});

test("the view carries tier, its reason and the spontaneous state", () => {
  const view = toView(row({ tier: "1", tier_reason: "tier 1: zone A, FR, 1 signal", spontaneous: "sent:2026-10-21:#7" }));
  assert.equal(view.tier, "1");
  assert.equal(view.tierReason, "tier 1: zone A, FR, 1 signal");
  assert.deepEqual(view.spontaneous, { state: "sent", date: "2026-10-21", tracker: 7 });
  const bare = toView(row());
  assert.equal(bare.tier, "none");
  assert.equal(bare.spontaneous.state, "none");
});

test("the summary counts prospects per tier and per spontaneous state", () => {
  const rows = [
    row({ key: "a", tier: "1" }), row({ key: "b", tier: "1", spontaneous: "drafted:2026-10-20" }),
    row({ key: "c", tier: "2" }), row({ key: "d", tier: "out" }), row({ key: "e", tier: "" }),
  ];
  const s = summarize(rows);
  assert.deepEqual(s.byTier, { 1: 2, 2: 1, 3: 0, out: 1, none: 1 });
  assert.deepEqual(s.bySpontaneous, { none: 4, drafted: 1, skipped: 0, sent: 0 });
});

test("the search string round-trips tier and state and leaves defaults out", () => {
  const query = { tier: "1", state: "drafted", sort: "name", dir: "asc", page: 1, pageSize: 50, zones: [], minSignals: 0 };
  const text = radarSearchString(query);
  assert.equal(text, "tier=1&state=drafted");
  const parsed = parseRadarQuery(new URLSearchParams(text));
  assert.equal(parsed.tier, "1");
  assert.equal(parsed.state, "drafted");
  assert.equal(radarSearchString({}), "");
});

// ---- parity with the engine -----------------------------------------------

test("spontaneousStateOf agrees with the engine's parseSpontaneous on every cell shape", () => {
  const cells = [
    "", "drafted:2026-10-20", "skipped:2026-10-20", "skipped:2026-10-20:why: more", "sent:2026-10-21:#123",
    "sent:2026-10-21", "foo", "drafted:yesterday", "drafted:2026-10-20:extra", "sent:2026-10-21:#x", "  ", "skipped:2026-1-2",
  ];
  for (const cell of cells) {
    assert.equal(spontaneousStateOf(cell), parseSpontaneous(cell).state, `cell "${cell}"`);
  }
});

test("filtering by tier selects exactly the rows the engine classifies that way", () => {
  const codeRoot = join(import.meta.dirname, "..", "..", "..");
  const rules = loadTierRules({ dataRoot: mkdtempSync(join(tmpdir(), "radar-tier-parity-")), codeRoot });
  const rows = [
    row({ key: "a", sites: "Colmar:A" }),
    row({ key: "b", sites: "Basel:B", signals: "0" }),
    row({ key: "c", sector: "56.10A" }),
    row({ key: "d", size_band: "1-2" }),
    row({ key: "e", sites: "Zug:D", country: "CH", signals: "0", tier_override: "1" }),
    row({ key: "f", sites: "" }),
  ].map((r) => {
    const c = classify(r, rules);
    return { ...r, tier: c.tier, tier_reason: c.reason };
  });
  for (const tier of ["1", "2", "3", "out"]) {
    const web = queryProspects(rows, q(`tier=${tier}&pageSize=100`)).rows.map((p) => p.key).sort();
    const engine = rows.filter((r) => r.tier === tier).map((r) => r.key).sort();
    assert.deepEqual(web, engine, `tier ${tier}`);
  }
  assert.ok(rows.some((r) => r.tier_override === "1" && r.tier === "1"), "the override row is tier 1");
});
