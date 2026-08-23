import { describe, expect, it } from "vitest";
import { validateUploadedCsvFile } from "./upload-validation";
import { MAX_UPLOAD_BYTES } from "./constants";

describe("validateUploadedCsvFile", () => {
  it("accepts a normal .csv upload", () => {
    expect(validateUploadedCsvFile({ size: 1024, type: "text/csv", name: "cellar.csv" })).toEqual({ ok: true });
  });

  it("accepts a .csv upload with an empty MIME type (common browser quirk)", () => {
    expect(validateUploadedCsvFile({ size: 1024, type: "", name: "cellar.csv" })).toEqual({ ok: true });
  });

  it("rejects a file over the size cap", () => {
    const result = validateUploadedCsvFile({ size: MAX_UPLOAD_BYTES + 1, type: "text/csv", name: "cellar.csv" });
    expect(result).toMatchObject({ ok: false, code: "too_large" });
  });

  it("rejects a non-.csv extension even with an allowed MIME type", () => {
    const result = validateUploadedCsvFile({ size: 1024, type: "text/csv", name: "cellar.xlsx" });
    expect(result).toMatchObject({ ok: false, code: "unsupported_media_type" });
  });

  it("rejects a disallowed MIME type", () => {
    const result = validateUploadedCsvFile({ size: 1024, type: "application/x-msdownload", name: "cellar.csv" });
    expect(result).toMatchObject({ ok: false, code: "unsupported_media_type" });
  });
});
