// The client's own view of GET /api/import/sessions/[id] — the subset of
// fields the session UI actually reads. Extracted verbatim from
// session-step.tsx, where both types were module-private.
//
// Deliberately NOT session-service.ts's own SessionChunkProgress/
// SessionProgress: those are the route's server-side shape (and carry
// sourceSha256, which this UI never reads). Kept in the app layer so the
// two never look like one type with two definitions.

export type SessionChunkProgress = {
  batchId: string;
  chunkIndex: number | null;
  status: string;
  counts: { total: number; applied: number; excluded: number; pending: number; eligibleNotApplied: number };
};

export type SessionProgress = {
  sessionId: string;
  status: string;
  declaredChunkTotal: number | null;
  chunks: SessionChunkProgress[];
  totals: SessionChunkProgress["counts"];
  allChunksPresent: boolean | null;
  allApplied: boolean;
};
