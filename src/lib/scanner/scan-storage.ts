import { PERSISTED_SCAN_VERSION, PersistedScanSchema } from "./schema";
import type { Scan } from "./types";

const STORAGE_KEY = "terroir:current-scan";

/**
 * BND-024 / ARCH-010 — the persisted scan is wrapped in a version
 * envelope: `{ version: N, data: Scan-without-rawText }`. Anything
 * that doesn't round-trip through PersistedScanSchema is dropped AND
 * removed from localStorage so a stale blob can't trigger the drop
 * path on every subsequent mount.
 *
 * Extracted from src/app/(app)/scan/scanner.tsx — the ONLY client that
 * persists an in-flight scan. src/app/(app)/scan-bottle/page.tsx keeps
 * its BND-112 session list in pure React state (never localStorage), so
 * there is no second implementation to reconcile here.
 */
export function loadScan(): Scan | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }

  const result = PersistedScanSchema.safeParse(parsed);
  if (!result.success) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return result.data.data as Scan;
}

export function saveScan(scan: Scan | null) {
  if (typeof window === "undefined") return;
  if (scan) {
    // Strip rawText to avoid bloating localStorage with OCR dumps
    const { rawText: _, ...data } = scan;
    const envelope = { version: PERSISTED_SCAN_VERSION, data };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}
