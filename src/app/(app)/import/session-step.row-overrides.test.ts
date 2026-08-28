// Inline row-fix (chunked path): the aggregated chunked preview shows
// GLOBAL row numbers, but each chunk is re-parsed from scratch server-side
// (buildImportPreview) — localizeRowOverrides translates an operator's
// edits into the LOCAL row numbers that specific chunk's own re-upload
// will assign, and confirmChunkedSession attaches only the slice each
// chunk actually needs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmChunkedSession,
  localizeRowOverrides,
  planChunkedPreview,
  ZERO_SUMMARY,
  type ChunkPlanItem,
  type ChunkUploadState,
  type ChunkedPlanState,
} from "./session-step";
import type { RowOverrides } from "./import-client";

describe("localizeRowOverrides", () => {
  it("keeps only the overrides that fall inside the chunk's [startRow, endRow] range, translated to local indices", () => {
    const overrides: RowOverrides = {
      1: { quantity: "6" },
      101: { name: "Fixed" },
      150: { unit_cost: "10.00" },
      200: { quantity: "1" },
    };
    const chunk = { startRow: 101, endRow: 150 };
    expect(localizeRowOverrides(overrides, chunk)).toEqual({
      "1": { name: "Fixed" },
      "50": { unit_cost: "10.00" },
    });
  });

  it("returns an empty object when no overrides fall inside the chunk", () => {
    expect(localizeRowOverrides({ 1: { quantity: "1" } }, { startRow: 101, endRow: 200 })).toEqual({});
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmChunkedSession — rowOverrides wiring", () => {
  it("attaches only the localized slice of overrides relevant to each chunk's own form data", async () => {
    const chunks: ChunkPlanItem[] = [
      { index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" },
      { index: 2, startRow: 3, endRow: 4, text: "producer,name,quantity\nA,D,1\nA,E,1\n" },
    ];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 2, chunks, sourceSha256: "a".repeat(64) };
    const sentRowOverrides: Array<string | null> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentRowOverrides.push((form.get("rowOverrides") as string | null) ?? null);
        return jsonResponse(200, { alreadyExists: false, batchId: `batch-${form.get("chunkIndex")}` });
      }),
    );

    const progressStates: ChunkUploadState[][] = [];
    const result = await confirmChunkedSession({
      plan,
      initialUpload: chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rowOverrides: { 1: { quantity: "6" }, 4: { name: "Fixed" } },
      onSessionId: () => {},
      onProgress: (upload) => progressStates.push(upload),
    });

    expect(result.ok).toBe(true);
    expect(sentRowOverrides[0]).toBe(JSON.stringify({ "1": { quantity: "6" } }));
    // Chunk 2 (rows 3-4): global row 4 -> local row 2. No override for
    // row 3, so the field is omitted entirely (never sent as "{}").
    expect(sentRowOverrides[1]).toBe(JSON.stringify({ "2": { name: "Fixed" } }));
  });

  it("omits the rowOverrides field entirely for a chunk with no relevant overrides", async () => {
    const chunks: ChunkPlanItem[] = [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" }];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 1, chunks, sourceSha256: "a".repeat(64) };
    let sentRowOverrides: string | null = "unset";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentRowOverrides = form.get("rowOverrides") as string | null;
        return jsonResponse(200, { alreadyExists: false, batchId: "batch-1" });
      }),
    );

    await confirmChunkedSession({
      plan,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rowOverrides: { 99: { quantity: "6" } },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(sentRowOverrides).toBeNull();
  });
});

// Sol audit (2026-08-27) finding 6: a blank record inside a chunk makes
// chunkEntry.startRow (which counts every record, blanks included) drift
// from the server's own DENSE row numbering (which drops blank lines
// before counting) — see the comment on errorRows.push in
// planChunkedPreview (session-step.tsx) for exactly what the resulting
// label means. This pins that meaning: "row N of this chunk's own data
// rows," not this row's true physical line number in the original file.
describe("planChunkedPreview — error-row labeling across a blank record (Sol audit finding 6)", () => {
  it("labels an error row by this chunk's dense data-row count, not its physical position among blank lines", async () => {
    // Two blank records precede the one real (erroring) record in this
    // single chunk. Physically this record is the file's 3rd row; the
    // server's own parser drops the two blanks before numbering, so it
    // reports this row as dense row 1 — the label below is 1, not 3.
    const dataRecords = ["", "", "P,,1"]; // blank name -> error
    const bytes = new TextEncoder().encode("producer,name,quantity\n\n\nP,,1\n");
    const file = new File(["producer,name,quantity\n\n\nP,,1\n"], "cellar.csv", { type: "text/csv" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          summary: { ...ZERO_SUMMARY, totalRows: 1, errorRows: 1 },
          rows: [
            {
              rowNumber: 1,
              rowState: "error",
              errors: [{ field: "name", message: "Wine name is required." }],
              rawText: { producer: "P", name: "", quantity: "1" },
            },
          ],
        }),
      ),
    );

    const result = await planChunkedPreview(file, "producer,name,quantity", dataRecords, bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.errorRows).toEqual([
      {
        rowNumber: 1,
        errors: [{ field: "name", message: "Wine name is required." }],
        rawText: { producer: "P", name: "", quantity: "1" },
      },
    ]);
  });
});
