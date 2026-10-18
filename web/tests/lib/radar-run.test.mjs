import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunTokens, planPreview, planSave } from "../../src/lib/radar-run.mjs";

const KNOWN = ["ats-employers", "sirene"];

function setup(extra = {}) {
  let now = 1_000_000;
  const tokens = createRunTokens({ now: () => now, ...extra });
  return { tokens, advance: (ms) => { now += ms; } };
}

test("a preview plan never contains --write, even when the body asks for it", () => {
  const plan = planPreview({ source: "sirene", write: true, writeToken: "x" }, KNOWN);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.argv, ["--source", "sirene", "--json"]);
  assert.equal(plan.argv.includes("--write"), false);
});

test("zones are validated, normalised and passed through", () => {
  const plan = planPreview({ source: "sirene", zones: ["c", "A", "A"] }, KNOWN);
  assert.deepEqual(plan.params, { source: "sirene", zones: ["A", "C"] });
  assert.deepEqual(plan.argv, ["--source", "sirene", "--json", "--zone", "A,C"]);
  assert.equal(planPreview({ source: "sirene", zones: ["Z"] }, KNOWN).status, 400);
  assert.equal(planPreview({ source: "sirene", zones: "A" }, KNOWN).status, 400);
});

test("only known source ids are accepted, never all, never a flag", () => {
  assert.equal(planPreview({ source: "nope" }, KNOWN).status, 400);
  assert.equal(planPreview({ source: "all" }, KNOWN).status, 400);
  assert.equal(planPreview({ source: "--write" }, KNOWN).status, 400);
  assert.equal(planPreview({ source: "sirene --write" }, KNOWN).status, 400);
  assert.equal(planPreview({}, KNOWN).status, 400);
  assert.equal(planPreview(null, KNOWN).status, 400);
});

test("save without a token is refused with 403", () => {
  const { tokens } = setup();
  const plan = planSave({ source: "sirene" }, KNOWN, tokens);
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 403);
});

test("a token issued for a preview lets exactly one save through", () => {
  const { tokens } = setup();
  const params = { source: "sirene", zones: ["A"] };
  const token = tokens.issue(params);
  assert.match(token, /^[0-9a-f]{32}$/);
  const first = planSave({ ...params, token }, KNOWN, tokens);
  assert.equal(first.ok, true);
  assert.deepEqual(first.argv, ["--source", "sirene", "--json", "--zone", "A", "--write"]);
  const second = planSave({ ...params, token }, KNOWN, tokens);
  assert.equal(second.status, 403, "a token cannot be reused");
});

test("a token is bound to its source and its zones", () => {
  const { tokens } = setup();
  const token = tokens.issue({ source: "sirene", zones: ["A"] });
  assert.equal(planSave({ source: "ats-employers", zones: ["A"], token }, KNOWN, tokens).status, 403);
  assert.equal(planSave({ source: "sirene", zones: ["B"], token }, KNOWN, tokens).status, 403);
  assert.equal(planSave({ source: "sirene", zones: ["A"], token }, KNOWN, tokens).ok, false, "a failed attempt burns the token");
});

test("a token expires after 30 minutes", () => {
  const { tokens, advance } = setup();
  const params = { source: "sirene" };
  const token = tokens.issue(params);
  advance(29 * 60 * 1000);
  assert.equal(tokens.consume(token, { source: "sirene", zones: [] }), true);
  const late = tokens.issue(params);
  advance(31 * 60 * 1000);
  assert.equal(planSave({ ...params, token: late }, KNOWN, tokens).status, 403);
});

test("a forged or non-string token is refused", () => {
  const { tokens } = setup();
  assert.equal(planSave({ source: "sirene", token: "deadbeef" }, KNOWN, tokens).status, 403);
  assert.equal(planSave({ source: "sirene", token: { toString: () => "x" } }, KNOWN, tokens).status, 403);
  assert.equal(planSave({ source: "sirene", token: ["a"] }, KNOWN, tokens).status, 403);
});

test("the save plan is built from the stored token record, not from the request body", () => {
  const { tokens } = setup();
  const token = tokens.issue({ source: "sirene", zones: ["A"] });
  const plan = planSave({ source: "sirene", zones: ["A"], token, write: false, argv: ["--evil"] }, KNOWN, tokens);
  assert.equal(plan.ok, true);
  assert.equal(plan.argv.includes("--evil"), false);
  assert.equal(plan.argv.at(-1), "--write");
});
