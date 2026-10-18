// Rules for running the radar from the web. This is the only place the Radar
// page can reach `radar.mjs --write`, so the gate lives here, in plain .mjs
// that `node --test` imports without a build.
//
// The flow is preview, then save:
//   1. A preview plan never contains --write, whatever the request body says.
//   2. A successful preview earns a single-use token bound to its source and
//      zones, valid for 30 minutes.
//   3. A save plan exists only when that token is presented and still matches.
//      A wrong attempt burns the token. The argv is built from the validated
//      parameters, never from the request body.

import { randomBytes } from "node:crypto";

const ZONES = new Set(["A", "B", "C", "D"]);
const TTL_MS = 30 * 60 * 1000;
const MAX_TOKENS = 20;
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

/** @typedef {{source: string, zones: string[]}} RunParams */
/** @typedef {{ok: false, status: number, error: string}} Refusal */
/** @typedef {{ok: true, params: RunParams, argv: string[]}} Plan */

/** @returns {Refusal} */
const refuse = (status, error) => ({ ok: false, status, error });

/**
 * Validate the request body's source and zones. Only a known source id passes:
 * never `all`, never anything that could be read as a flag.
 *
 * @param {unknown} body
 * @param {string[]} knownSourceIds ids reported by `radar.mjs --sources`
 * @returns {{ok: true, params: RunParams} | Refusal}
 */
function parseParams(body, knownSourceIds) {
  if (!body || typeof body !== "object") return refuse(400, "Expected a JSON object.");
  const { source, zones } = /** @type {Record<string, unknown>} */ (body);
  if (typeof source !== "string" || !knownSourceIds.includes(source)) return refuse(400, "Unknown radar source.");
  if (zones !== undefined && !Array.isArray(zones)) return refuse(400, "zones must be a list of letters from A to D.");
  const letters = [];
  for (const z of zones ?? []) {
    const letter = typeof z === "string" ? z.trim().toUpperCase() : "";
    if (!ZONES.has(letter)) return refuse(400, "zones must be letters from A to D.");
    if (!letters.includes(letter)) letters.push(letter);
  }
  return { ok: true, params: { source, zones: letters.sort() } };
}

/** @param {{source: string, zones: string[]}} params @param {{write: boolean}} mode */
function buildArgs(params, { write }) {
  const argv = ["--source", params.source, "--json"];
  if (params.zones.length) argv.push("--zone", params.zones.join(","));
  if (write) argv.push("--write");
  return argv;
}

/**
 * Plan a preview run. The result never carries --write.
 * @param {unknown} body
 * @param {string[]} knownSourceIds
 * @returns {Plan | Refusal}
 */
export function planPreview(body, knownSourceIds) {
  const parsed = parseParams(body, knownSourceIds);
  if (!parsed.ok) return parsed;
  return { ok: true, params: parsed.params, argv: buildArgs(parsed.params, { write: false }) };
}

/**
 * Single-use run tokens, kept in memory.
 *
 * @param {{now?: () => number, ttlMs?: number, random?: () => string}} [options]
 */
export function createRunTokens({ now = Date.now, ttlMs = TTL_MS, random = () => randomBytes(16).toString("hex") } = {}) {
  /** @type {Map<string, {source: string, zones: string, expires: number}>} */
  const store = new Map();
  const key = (zones) => [...(zones ?? [])].sort().join(",");
  return {
    issue(params) {
      const token = random();
      store.set(token, { source: params.source, zones: key(params.zones), expires: now() + ttlMs });
      while (store.size > MAX_TOKENS) store.delete(store.keys().next().value);
      return token;
    },
    /** True only for a live token that matches. Any presented token is spent. */
    consume(token, params) {
      if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return false;
      const record = store.get(token);
      if (!record) return false;
      store.delete(token);
      return record.expires > now() && record.source === params.source && record.zones === key(params.zones);
    },
  };
}

/** The process-wide token store, shared by the run and save routes. */
export function sharedRunTokens() {
  const g = /** @type {any} */ (globalThis);
  g.__radarRunTokens ??= createRunTokens();
  return g.__radarRunTokens;
}

/**
 * Plan a save. It exists only when a valid token for the same source and zones is presented.
 * @param {unknown} body
 * @param {string[]} knownSourceIds
 * @param {{consume: (token: unknown, params: RunParams) => boolean}} tokens
 * @returns {Plan | Refusal}
 */
export function planSave(body, knownSourceIds, tokens) {
  const parsed = parseParams(body, knownSourceIds);
  if (!parsed.ok) return parsed;
  const token = /** @type {Record<string, unknown>} */ (body).token;
  if (!tokens.consume(token, parsed.params)) return refuse(403, "Run a preview first: saving needs a fresh, matching preview.");
  return { ok: true, params: parsed.params, argv: buildArgs(parsed.params, { write: true }) };
}
