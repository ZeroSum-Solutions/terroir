// Per-browser persistence of the in-progress import session id, so a page
// reload mid-multi-chunk upload can reconcile against the server rather
// than starting over. Extracted verbatim from session-step.tsx, which
// re-exports readStoredSession/writeStoredSession/StoredSession unchanged.

// Resume: sessionId persisted per-browser so a page reload mid-multi-chunk
// upload can reconcile against the server rather than starting over.
// try/catch on every access — never load-bearing if storage is unavailable.
const IMPORT_SESSION_STORAGE_KEY = "terroir-import-session-v1";

export type StoredSession = { sessionId: string; sourceSha256: string; label: string };

export function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(IMPORT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.sessionId !== "string") return null;
    return {
      sessionId: parsed.sessionId,
      sourceSha256: typeof parsed.sourceSha256 === "string" ? parsed.sourceSha256 : "",
      label: typeof parsed.label === "string" ? parsed.label : "cellar.csv",
    };
  } catch {
    return null;
  }
}

export function writeStoredSession(value: StoredSession | null) {
  try {
    if (value === null) window.localStorage.removeItem(IMPORT_SESSION_STORAGE_KEY);
    else window.localStorage.setItem(IMPORT_SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // best-effort — resume is a convenience only, never load-bearing.
  }
}

// Client-side pacing, matching /api/import/batches' own CONFIRM_RATE_LIMIT
// (10/60s, src/app/api/import/batches/route.ts) with a one-request margin
// so a same-tab retry never itself trips the server's limiter.
