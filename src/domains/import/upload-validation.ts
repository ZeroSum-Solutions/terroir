// G1-4 — server-side upload validation, independent of Next.js response
// types so it's trivial to unit test.

import { ALLOWED_CSV_MIME_TYPES, MAX_UPLOAD_BYTES } from "./constants";

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; code: "too_large" | "unsupported_media_type"; message: string };

export function validateUploadedCsvFile(file: { size: number; type: string; name: string }): UploadValidationResult {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "too_large", message: `File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  }

  const hasCsvExtension = file.name.toLowerCase().endsWith(".csv");
  const hasAllowedMime = file.type === "" || ALLOWED_CSV_MIME_TYPES.has(file.type);

  if (!hasCsvExtension || !hasAllowedMime) {
    return {
      ok: false,
      code: "unsupported_media_type",
      message: "Only .csv files are accepted.",
    };
  }

  return { ok: true };
}
