// Which preview path a file takes, and the decode/split error messages on
// the way there. This ran inline in handlePreview (import-client.tsx) and
// could previously only be reached by driving the whole component.
import { describe, expect, it } from "vitest";
import { preparePreviewRun } from "./preview-dispatch";
import { CANONICAL_HEADERS, MAX_ROWS } from "./constants";

const HEADER = CANONICAL_HEADERS.join(",");

function csvFile(text: string, name = "cellar.csv"): File {
  return new File([text], name, { type: "text/csv" });
}

function dataRows(count: number): string {
  return Array.from({ length: count }, (_, i) => `Domaine A,Cuvee ${i + 1},2020,,,,750,,USD,6,24.50,,`).join("\n");
}

describe("preparePreviewRun", () => {
  it("routes a file at the MAX_ROWS ceiling to the single-unit path", async () => {
    const result = await preparePreviewRun(csvFile(`${HEADER}\n${dataRows(MAX_ROWS)}\n`));
    expect(result).toEqual({ ok: true, kind: "single" });
  });

  it("routes a file one row over MAX_ROWS to the chunked path, with the header split off", async () => {
    const result = await preparePreviewRun(csvFile(`${HEADER}\n${dataRows(MAX_ROWS + 1)}\n`));
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "chunked") throw new Error("expected the chunked path");
    expect(result.headerRecord).toBe(HEADER);
    expect(result.dataRecords).toHaveLength(MAX_ROWS + 1);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
  });

  it("reports an empty file rather than routing it anywhere", async () => {
    expect(await preparePreviewRun(csvFile(""))).toEqual({ ok: false, error: "File is empty." });
  });

  it("surfaces the decoder's own message for a file it cannot decode", async () => {
    // A lone 0x80 byte is not valid UTF-8 and has no BOM to explain it.
    const result = await preparePreviewRun(new File([new Uint8Array([0x80, 0x81])], "cellar.csv"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a decode failure");
    expect(result.error.length).toBeGreaterThan(0);
  });
});
