"use client";

// The import screen's resume-on-mount check, extracted verbatim from
// ImportClient (import-client.tsx) so that component could take on the
// SCAN-03 source-preset state without growing past the file-size ratchet.
// The behaviour, the ordering and the audit reasoning below are unchanged;
// only the location is.

import { useEffect } from "react";
import { readStoredSession, writeStoredSession } from "./session-step";

/**
 * If a prior session is still in progress (per this browser's
 * localStorage), hand it back to the caller so it can jump straight to its
 * SessionStep — reconciled against the server's own progress, never
 * trusted on its own.
 *
 * Round-6 audit finding 4(b): a session with a client-side-skipped chunk
 * (SessionStep's own comment) can NEVER derive status='completed'
 * (getImportSessionProgress, session-service.ts) — it stays "in_progress"
 * on the server forever. VERIFIED every other reader of this status,
 * grepping across src/ for every place progress.status (or the raw
 * import_sessions.status column) is read:
 *   - THIS hook: the early return below only fires for "reverted"/
 *     "completed", so a permanently-"in_progress" session keeps landing
 *     the operator back on its own SessionStep on every reload — until
 *     they explicitly click "Start a new import" (writeStoredSession(null),
 *     the SessionStep/BatchStep onDone handlers).
 *   - SessionStep's own status pill (session-step.tsx): renders "In
 *     progress" forever instead of "Completed" — a cosmetic difference
 *     only, not a functional gate.
 *   - SessionStep's pending-resolution and revert-button gates
 *     (`progress.status !== "reverted"`): both treat "in_progress" and
 *     "completed" IDENTICALLY — a stuck-at-in_progress session behaves
 *     exactly like a completed one for apply/resolve/revert.
 *   - No cron/cleanup job, no other UI surface, and no other file reads
 *     this status at all. A permanently in_progress session is therefore
 *     benign everywhere: at worst a stale status LABEL and a reload that
 *     returns you to the same place, never a hard error, a blocked
 *     action, or a resource leak.
 */
export function useSessionResume(onResume: (sessionId: string, label: string) => void) {
  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) return;
    let active = true;
    (async () => {
      try {
        const response = await fetch(`/api/import/sessions/${stored.sessionId}`, { cache: "no-store" });
        if (!response.ok) {
          writeStoredSession(null);
          return;
        }
        const progress = (await response.json()) as { status: string };
        if (!active) return;
        if (progress.status === "reverted" || progress.status === "completed") {
          // Nothing left to resume — never re-jump into a finished session.
          writeStoredSession(null);
          return;
        }
        onResume(stored.sessionId, stored.label);
      } catch {
        // best-effort — resume is a convenience, never load-bearing.
      }
    })();
    return () => {
      active = false;
    };
    // Mount-only, exactly as before: this is a resume CHECK, not a
    // subscription to onResume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
