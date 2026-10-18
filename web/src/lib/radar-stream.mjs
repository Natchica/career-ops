// Small, testable rules for turning a `radar.mjs` child process into the events
// the Radar page shows. The process boundary itself lives in
// src/lib/core/radar-run.ts; this file only decides what its output means.

/** The CLI's receipt: the JSON object it prints on stdout, or null for anything else. */
export function parseReceipt(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.sources) && typeof parsed.mode === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** One stderr line as a progress message, or null when there is nothing to show. */
export function progressMessage(line) {
  const text = String(line ?? "").trim();
  return text ? text.slice(0, 160) : null;
}

/**
 * Whether a receipt lets the page offer "Save": a preview, that wrote nothing,
 * in which the requested source ran cleanly. Failed and skipped sources earn
 * nothing, so a broken run can never be saved.
 */
export function earnsToken(receipt, sourceId) {
  if (!receipt || receipt.mode !== "preview" || receipt.written !== false) return false;
  const source = (receipt.sources ?? []).find((s) => s.id === sourceId);
  return !!source && source.status === "ok";
}
