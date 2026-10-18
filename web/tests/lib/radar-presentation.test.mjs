import { test } from "node:test";
import assert from "node:assert/strict";
import { ZONE_TONES, zoneTone, signalLevel, SIZE_BANDS } from "../../src/lib/radar-presentation.mjs";

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
