"use client";

// The preview/confirm "unit" count for the currently-selected file, and
// whether that count reflects THIS file yet. Extracted verbatim from
// ImportClient (import-client.tsx) — same state, same render-phase
// adjustment, same effect, in the same order.

import { useEffect, useState } from "react";
import { countPreviewUnits } from "@/domains/import/preview-units";
import type { PreviewUnitsStatus } from "./upload-step";

export function usePreviewUnits(file: File | null): {
  previewUnits: number | null;
  previewUnitsStatus: PreviewUnitsStatus;
} {
  // BLOCK 1 (round-11 fix, was WARN 4 round-29 audit): the number of
  // preview/confirm "units" this file needs — a chunk count for a file
  // over MAX_ROWS, or 1 for a file that previews/confirms as a single
  // unit. estimateChunkedPhaseWaitSeconds(previewUnits) turns this into the
  // operator-facing wait estimate for ONE phase (preview OR confirm) of
  // THIS file. Computed by the effect below as soon as a file is selected —
  // BEFORE the operator ever clicks Preview, not merely before the network
  // call inside it — so a plain (<= MAX_ROWS) file gets the same advance
  // disclosure a chunked one already did, and neither path's warning
  // depends on the operator having already committed to the wait.
  //
  // BLOCK 1 (round-13 fix) — previewUnits alone can't distinguish "not
  // known yet for THIS file" from "known to be unavailable," and nothing
  // used to stop the operator from clicking Preview during that gap, or
  // from reading the PREVIOUS file's estimate while a new one was still
  // resolving (see countPreviewUnits' own comment and PreviewUnitsStatus
  // above). previewUnitsStatus tracks that explicitly.
  //
  // The stale value is cleared SYNCHRONOUSLY, DURING RENDER, the instant
  // `file` changes — React's own "adjusting state when a prop changes"
  // pattern (comparing against a ref-like previewUnitsFile state and
  // calling setState in the render body, not inside an effect): this is
  // what actually closes both races, since it happens before the browser
  // ever paints the old value, not merely "before the next effect flush."
  // Doing this inside a useEffect body instead (the more obvious spot)
  // trips `react-hooks/set-state-in-effect` — an unconditional setState
  // call in an effect causes an extra cascading render for no benefit
  // when the render-phase pattern achieves the same synchronous clear.
  // The actual async count still lives in its own effect below, which
  // only ever calls setState from its `.then()` callback (not the effect
  // body itself), which the same lint rule allows.
  const [previewUnits, setPreviewUnits] = useState<number | null>(null);
  const [previewUnitsStatus, setPreviewUnitsStatus] = useState<PreviewUnitsStatus>("idle");
  const [previewUnitsFile, setPreviewUnitsFile] = useState<File | null>(file);
  if (file !== previewUnitsFile) {
    setPreviewUnitsFile(file);
    setPreviewUnits(null);
    setPreviewUnitsStatus(file ? "pending" : "idle");
  }
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void countPreviewUnits(file).then((units) => {
      if (cancelled) return;
      setPreviewUnits(units);
      setPreviewUnitsStatus(units === null ? "unavailable" : "ready");
    });
    return () => {
      cancelled = true;
    };
  }, [file]);
  return { previewUnits, previewUnitsStatus };
}
