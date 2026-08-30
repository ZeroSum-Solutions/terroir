// Which preview path a selected file takes, and every "this file can't be
// read" message on the way there: decode strictly, split into logical
// records, then route at MAX_ROWS — at or under it the whole file previews
// as one unit, over it the client-side chunker takes over.
//
// Extracted verbatim from handlePreview (import-client.tsx), where the
// decode/split error mapping could only be exercised by driving the
// component. The caller keeps its own outer try/catch for the generic
// "check your connection" fallback, exactly as before.

import { MAX_ROWS } from "./constants";
import {
  AmbiguousRecordSplitError,
  UnsupportedEncodingError,
  UnsupportedLineEndingError,
  decodeCsvBytesStrict,
  splitLogicalRecords,
} from "./csv-splitter";

export type PreviewRunPlan =
  | { ok: false; error: string }
  | { ok: true; kind: "single" }
  | { ok: true; kind: "chunked"; headerRecord: string; dataRecords: string[]; bytes: Uint8Array };

export async function preparePreviewRun(file: File): Promise<PreviewRunPlan> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let text: string;
  try {
    text = decodeCsvBytesStrict(bytes);
  } catch (err) {
    return { ok: false, error: err instanceof UnsupportedEncodingError ? err.message : "Could not read this CSV file." };
  }

  let allRecords: string[];
  try {
    allRecords = splitLogicalRecords(text);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof AmbiguousRecordSplitError || err instanceof UnsupportedLineEndingError
          ? err.message
          : "Could not read this CSV file.",
    };
  }
  if (allRecords.length === 0) {
    return { ok: false, error: "File is empty." };
  }

  // BLOCK 1 (round-11 fix): the operator's wait estimate (previewUnits,
  // shown by UploadStep) was already computed by countPreviewUnits when
  // this file was selected — nothing to (re)set here.
  const [headerRecord, ...dataRecords] = allRecords;
  if (dataRecords.length <= MAX_ROWS) return { ok: true, kind: "single" };
  return { ok: true, kind: "chunked", headerRecord, dataRecords, bytes };
}
