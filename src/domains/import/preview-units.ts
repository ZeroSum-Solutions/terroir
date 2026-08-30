// How many preview/confirm "units" (chunks, or 1 for a file at or under
// MAX_ROWS that never gets split) a selected file will need. Extracted
// verbatim from import-client.tsx, where it was module-private.

import { CLIENT_CHUNK_TARGET_ROWS, MAX_ROWS } from "./constants";
import { buildChunkPlan, decodeCsvBytesStrict, splitLogicalRecords } from "./csv-splitter";


/** BLOCK 1 (round-11 fix) — how many preview/confirm "units" (chunks, or 1
 * for a file at/under MAX_ROWS that never gets split) this file will need,
 * computed eagerly as soon as a file is selected so the operator wait
 * estimate (estimateChunkedPhaseWaitSeconds) is known BEFORE they commit to
 * either phase, not merely once they've already clicked Preview. Shares the
 * exact decode/split/chunk-plan functions handlePreview itself uses (see
 * below), so the early estimate and the actual preview path can never
 * disagree on chunk count. Returns null for a file that can't even be
 * decoded/split — an early estimate has nothing honest to show for a file
 * that's about to fail outright; handlePreview surfaces the real error once
 * the operator actually clicks Preview. */
export async function countPreviewUnits(file: File): Promise<number | null> {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const text = decodeCsvBytesStrict(bytes);
    const allRecords = splitLogicalRecords(text);
    if (allRecords.length === 0) return null;
    const dataRecords = allRecords.slice(1);
    if (dataRecords.length <= MAX_ROWS) return 1;
    return buildChunkPlan(dataRecords, CLIENT_CHUNK_TARGET_ROWS).length;
  } catch {
    return null;
  }
}
