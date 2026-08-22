/**
 * M1-1: client-side scan latency instrumentation.
 *
 * Records User Timing marks (`performance.mark`) for the client-observable
 * stages of a scan — capture (tap-to-file-selected), prep (building the
 * upload request), upload (the network round trip), and render (state
 * update through next paint) — then reports each stage's measured
 * duration to Sentry as a structured log entry. `enableLogs` is already
 * configured in instrumentation-client.ts, so this is a complement to
 * existing Sentry conventions rather than a new integration: logs aren't
 * subject to the 10%-in-prod trace sampling, so a single scan's stage
 * breakdown isn't lost the way a sampled-out span would be. Correlate a
 * scan's client stages with its server-side spans (see
 * `src/domains/scanning/scan-telemetry.ts`) via `scanId`, which is the
 * scan's existing idempotency key (a random client-generated UUID).
 *
 * Every export here is defensive: capturing or reporting timing can never
 * throw, block, or otherwise affect the scan itself (M1-1 acceptance #2).
 * Marks and log attributes carry only stage names, the scan id, byte/item
 * counts, and durations — never file contents, OCR text, wine names, or
 * invoice amounts.
 */
import * as Sentry from "@sentry/nextjs";

export type ClientScanStage = "capture" | "prep" | "upload" | "render";

const MARK_NAMESPACE = "terroir:scan";

function markKey(stage: ClientScanStage, edge: "start" | "end"): string {
  return `${MARK_NAMESPACE}:${stage}:${edge}`;
}

/** Records a User Timing mark for a stage boundary. Never throws. */
export function markScanStage(stage: ClientScanStage, edge: "start" | "end"): void {
  try {
    if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
    performance.mark(markKey(stage, edge));
  } catch {
    // Timing capture must never affect the scan (M1-1 acceptance #2).
  }
}

/**
 * Measures a stage's most recent start/end mark pair and reports the
 * duration to Sentry as a `scan.client.<stage>` log entry, then clears
 * those marks so a retried scan measures fresh boundaries. Returns the
 * measured duration in ms, or null if the stage was never fully marked
 * (e.g. a test that dispatches the file input directly, skipping the
 * button click that marks "capture:start"). Never throws.
 */
export function reportScanStage(
  scanId: string,
  stage: ClientScanStage,
  extra: Record<string, string | number | boolean> = {},
): number | null {
  try {
    if (typeof performance === "undefined" || typeof performance.measure !== "function") {
      return null;
    }
    const startKey = markKey(stage, "start");
    const endKey = markKey(stage, "end");
    if (performance.getEntriesByName(startKey).length === 0) return null;
    if (performance.getEntriesByName(endKey).length === 0) return null;

    const measureName = `${MARK_NAMESPACE}:${stage}:measure`;
    const measure = performance.measure(measureName, startKey, endKey);
    const durationMs = Math.round(measure.duration);

    Sentry.logger?.info?.(`scan.client.${stage}`, {
      scanId,
      stage,
      durationMs,
      ...extra,
    });

    performance.clearMarks(startKey);
    performance.clearMarks(endKey);
    performance.clearMeasures(measureName);

    return durationMs;
  } catch {
    return null;
  }
}
