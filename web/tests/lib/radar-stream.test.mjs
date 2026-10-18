import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt, progressMessage, earnsToken } from "../../src/lib/radar-stream.mjs";

const receipt = (over = {}) => ({
  mode: "preview", written: false, collisions: [], prospects: { new: 2, known: 0, total: 2 },
  sources: [{ id: "sirene", status: "ok", reason: null, raw: 5, zoned: 3, unzoned: 2 }], ...over,
});

test("a receipt is the CLI's JSON on stdout", () => {
  const parsed = parseReceipt(JSON.stringify(receipt(), null, 2) + "\n");
  assert.equal(parsed.prospects.new, 2);
});

test("anything else on stdout is not a receipt", () => {
  assert.equal(parseReceipt(""), null);
  assert.equal(parseReceipt("Error: boom"), null);
  assert.equal(parseReceipt("[1,2,3]"), null);
  assert.equal(parseReceipt('{"hello":1}'), null);
  assert.equal(parseReceipt('{"mode":"preview"}'), null, "a receipt needs its sources list");
});

test("progress lines are trimmed, capped and blank lines dropped", () => {
  assert.equal(progressMessage("  sirene: 68100 done  \n"), "sirene: 68100 done");
  assert.equal(progressMessage("   "), null);
  assert.equal(progressMessage(""), null);
  assert.equal(progressMessage("x".repeat(500)).length, 160);
});

test("a token is earned only by a clean preview of the requested source", () => {
  assert.equal(earnsToken(receipt(), "sirene"), true);
  assert.equal(earnsToken(receipt({ written: true, mode: "write" }), "sirene"), false);
  assert.equal(earnsToken(receipt({ sources: [{ id: "sirene", status: "failed", reason: "HTTP 500", raw: 0, zoned: 0, unzoned: 0 }] }), "sirene"), false);
  assert.equal(earnsToken(receipt({ sources: [{ id: "sirene", status: "skipped", reason: "missing credentials", raw: 0, zoned: 0, unzoned: 0 }] }), "sirene"), false);
  assert.equal(earnsToken(receipt(), "ats-employers"), false, "the receipt is for another source");
  assert.equal(earnsToken(null, "sirene"), false);
});
