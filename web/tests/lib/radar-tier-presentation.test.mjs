import { test } from "node:test";
import assert from "node:assert/strict";
import { TIER_TONES, tierTone, STATE_TONES, stateTone, ZONE_TONES } from "../../src/lib/radar-presentation.mjs";

const TIERS = ["1", "2", "3", "out", "none"];
const STATES = ["none", "drafted", "skipped", "sent"];

test("every tier has text, a screen-reader string and a dark-mode chip, so colour never stands alone", () => {
  for (const tier of TIERS) {
    const tone = TIER_TONES[tier];
    assert.ok(tone.label.length > 0, `tier ${tier} label`);
    assert.ok(tone.sr.length > 3, `tier ${tier} sr`);
    assert.match(tone.chip, /dark:/, `tier ${tier} dark variant`);
  }
  assert.equal(TIER_TONES["1"].label, "T1");
  assert.equal(TIER_TONES.out.label, "Out");
  assert.equal(TIER_TONES.none.label, "Not tiered");
});

test("tiers use different chip classes and none reuses a zone hue", () => {
  const chips = TIERS.map((t) => TIER_TONES[t].chip);
  assert.equal(new Set(chips).size, TIERS.length);
  const zoneHues = ["A", "B", "C", "D"].map((z) => ZONE_TONES[z].chip.match(/bg-(\w+)-500/)[1]);
  for (const tier of ["1", "2", "3"]) {
    const hue = TIER_TONES[tier].chip.match(/bg-(\w+)-500/)[1];
    assert.ok(!zoneHues.includes(hue), `tier ${tier} hue ${hue} collides with a zone`);
  }
});

test("an unknown tier falls back to not tiered", () => {
  assert.equal(tierTone("9"), TIER_TONES.none);
  assert.equal(tierTone(undefined), TIER_TONES.none);
  assert.equal(tierTone("out"), TIER_TONES.out);
});

test("every state has a label and a dark-mode chip, and an unknown state falls back to none", () => {
  for (const state of STATES) {
    assert.ok(STATE_TONES[state].label.length > 0, `state ${state} label`);
    assert.match(STATE_TONES[state].chip, /dark:/, `state ${state} dark variant`);
  }
  assert.equal(stateTone("nope"), STATE_TONES.none);
});
