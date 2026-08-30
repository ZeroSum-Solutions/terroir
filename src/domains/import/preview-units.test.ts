// The eager preview/confirm unit count behind the operator's wait estimate.
// This was module-private in import-client.tsx and observable only through
// the rendered estimate line.
import { describe, expect, it } from "vitest";
import { countPreviewUnits } from "./preview-units";
import { CANONICAL_HEADERS, CLIENT_CHUNK_TARGET_ROWS, MAX_ROWS } from "./constants";

const HEADER = CANONICAL_HEADERS.join(",");

function csvFile(dataRowCount: number): File {
  const rows = Array.from(
    { length: dataRowCount },
    (_, i) => `Domaine A,Cuvee ${i + 1},2020,,,,750,,USD,6,24.50,,`,
  ).join("\n");
  return new File([`${HEADER}\n${rows}\n`], "cellar.csv", { type: "text/csv" });
}

describe("countPreviewUnits", () => {
  it("counts a file at or under MAX_ROWS as a single unit", async () => {
    expect(await countPreviewUnits(csvFile(10))).toBe(1);
    expect(await countPreviewUnits(csvFile(MAX_ROWS))).toBe(1);
  });

  it("counts the chunk plan for a file over MAX_ROWS", async () => {
    const rows = MAX_ROWS + 1;
    expect(await countPreviewUnits(csvFile(rows))).toBe(Math.ceil(rows / CLIENT_CHUNK_TARGET_ROWS));
  });

  it("returns null for a header-only file, which has nothing to preview", async () => {
    expect(await countPreviewUnits(new File([""], "cellar.csv"))).toBeNull();
  });

  it("returns null rather than throwing for a file it cannot even decode", async () => {
    expect(await countPreviewUnits(new File([new Uint8Array([0x80, 0x81])], "cellar.csv"))).toBeNull();
  });
});
