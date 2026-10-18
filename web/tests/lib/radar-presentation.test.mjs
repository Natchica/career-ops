import { test } from "node:test";
import assert from "node:assert/strict";
import { ZONE_TONES, zoneTone, signalLevel, SIZE_BANDS, coverageView } from "../../src/lib/radar-presentation.mjs";

test("every zone tone carries a letter and a text label, so colour never stands alone", () => {
  for (const letter of ["A", "B", "C", "D"]) {
    const tone = ZONE_TONES[letter];
    assert.equal(tone.letter, letter);
    assert.ok(tone.label.length > 3, `zone ${letter} has a label`);
    assert.ok(tone.hint.length > 3, `zone ${letter} has a hint`);
  }
});

test("the four zones use four different hues", () => {
  const chips = ["A", "B", "C", "D"].map((z) => ZONE_TONES[z].chip);
  assert.equal(new Set(chips).size, 4);
  const dots = ["A", "B", "C", "D"].map((z) => ZONE_TONES[z].dot);
  assert.equal(new Set(dots).size, 4);
});

test("every tone ships a dark-mode variant", () => {
  for (const letter of ["A", "B", "C", "D"]) {
    assert.match(ZONE_TONES[letter].chip, /dark:/);
  }
});

test("an unknown zone falls back to a neutral tone with a text label", () => {
  const tone = zoneTone("Z");
  assert.equal(tone.letter, "?");
  assert.ok(tone.label.length > 0);
});

test("signal levels run 0 to 4 and always carry a text label", () => {
  for (let n = 0; n <= 4; n++) {
    const level = signalLevel(n);
    assert.equal(level.filled, n);
    assert.equal(level.total, 4);
    assert.equal(level.label, `${n}/4`);
    assert.ok(level.description.length > 3);
  }
  assert.equal(signalLevel(9).filled, 4, "clamped to 4");
  assert.equal(signalLevel(-1).filled, 0, "clamped to 0");
  assert.equal(signalLevel("x").filled, 0);
});

test("size bands list in ascending order with unknown first", () => {
  assert.equal(SIZE_BANDS[0], "?");
  assert.equal(SIZE_BANDS.at(-1), "10000+");
  assert.equal(new Set(SIZE_BANDS).size, SIZE_BANDS.length);
});

const coverage = (over = {}) => ({
  baseline: { size: 89, unzoned: 4, unzoned_names: [] }, found: 62, recall_all: 0.6966, recall_excluding_ats_employers: 0.25,
  missing: ["A"], missing_total: 27, missing_excluding_ats_employers: [], missing_excluding_ats_employers_total: 67, ...over,
});

test("coverage without a baseline says so and never shows a percentage", () => {
  const view = coverageView(coverage({ baseline: { size: 0, unzoned: 0, unzoned_names: [] }, recall_all: null, recall_excluding_ats_employers: null, found: 0, missing: [], missing_total: 0 }));
  assert.equal(view.percent, null);
  assert.match(view.headline, /No baseline yet/);
  assert.equal(view.registersPercent, null);
});

test("coverage shows rounded percentages for both measures with a text verdict", () => {
  const view = coverageView(coverage());
  assert.equal(view.percent, 70);
  assert.equal(view.registersPercent, 25);
  assert.match(view.headline, /70%/);
  assert.match(view.headline, /89/);
  assert.ok(view.verdict.length > 3);
});

test("the verdict follows the honest registers figure when there is one, otherwise the overall figure", () => {
  assert.equal(coverageView(coverage({ recall_all: 1, recall_excluding_ats_employers: 0.1 })).tone, "low", "100% overall is not nearly complete when the registers found 10%");
  assert.equal(coverageView(coverage({ recall_all: 0.2, recall_excluding_ats_employers: 0.95 })).tone, "good");
  assert.equal(coverageView(coverage({ recall_all: 0.6, recall_excluding_ats_employers: null })).tone, "ok");
});

test("the verdict tone has three bands and always carries words", () => {
  for (const [r, tone] of [[0.95, "good"], [0.6, "ok"], [0.1, "low"]]) {
    const view = coverageView(coverage({ recall_all: r, recall_excluding_ats_employers: r }));
    assert.equal(view.tone, tone);
    assert.ok(view.verdict.length > 3);
  }
});

test("the missing count and the unplaceable tracked companies are reported", () => {
  const view = coverageView(coverage());
  assert.equal(view.missingTotal, 27);
  assert.equal(view.unzoned, 4);
});
