// Item 2 (per-row LWIN match visibility/rejection), chunked path — mirrors
// session-step.row-overrides.test.ts's own structure exactly:
// localizeRejectedLwinRows is the rejectedLwinRows counterpart to
// localizeRowOverrides, confirmChunkedSession must attach only each
// chunk's own localized slice, and planChunkedPreview must accumulate a
// matchedRows entry (mirroring its own errorRows accumulation) for every
// matched row across every chunk.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmChunkedSession,
  localizeRejectedLwinRows,
  planChunkedPreview,
  ZERO_SUMMARY,
  type ChunkPlanItem,
  type ChunkedPlanState,
} from "./session-step";

describe("localizeRejectedLwinRows", () => {
  it("keeps only the rejected rows that fall inside the chunk's [startRow, endRow] range, translated to local indices", () => {
    const rejected = new Set([1, 101, 150, 200]);
    const chunk = { startRow: 101, endRow: 150 };
    expect(localizeRejectedLwinRows(rejected, chunk)).toEqual(["1", "50"]);
  });

  it("returns an empty array when no rejected rows fall inside the chunk", () => {
    expect(localizeRejectedLwinRows(new Set([1]), { startRow: 101, endRow: 200 })).toEqual([]);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmChunkedSession — rejectedLwinRows wiring", () => {
  it("attaches only the localized slice of rejected rows relevant to each chunk's own form data", async () => {
    const chunks: ChunkPlanItem[] = [
      { index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" },
      { index: 2, startRow: 3, endRow: 4, text: "producer,name,quantity\nA,D,1\nA,E,1\n" },
    ];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 2, chunks, sourceSha256: "a".repeat(64) };
    const sentRejectedLwinRows: Array<string | null> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentRejectedLwinRows.push((form.get("rejectedLwinRows") as string | null) ?? null);
        return jsonResponse(200, { alreadyExists: false, batchId: `batch-${form.get("chunkIndex")}` });
      }),
    );

    const result = await confirmChunkedSession({
      plan,
      initialUpload: chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rejectedLwinRows: new Set([1, 4]),
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result.ok).toBe(true);
    expect(sentRejectedLwinRows[0]).toBe(JSON.stringify(["1"]));
    // Chunk 2 (rows 3-4): global row 4 -> local row 2. No rejection for
    // row 3, so only row 2 is sent.
    expect(sentRejectedLwinRows[1]).toBe(JSON.stringify(["2"]));
  });

  it("omits the rejectedLwinRows field entirely for a chunk with no relevant rejections", async () => {
    const chunks: ChunkPlanItem[] = [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" }];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 1, chunks, sourceSha256: "a".repeat(64) };
    let sentRejectedLwinRows: string | null = "unset";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentRejectedLwinRows = form.get("rejectedLwinRows") as string | null;
        return jsonResponse(200, { alreadyExists: false, batchId: "batch-1" });
      }),
    );

    await confirmChunkedSession({
      plan,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      rejectedLwinRows: new Set([99]),
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(sentRejectedLwinRows).toBeNull();
  });

  it("omits the field entirely when rejectedLwinRows is not provided at all (plain overrides-only callers keep working)", async () => {
    const chunks: ChunkPlanItem[] = [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" }];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 1, chunks, sourceSha256: "a".repeat(64) };
    let sentRejectedLwinRows: string | null = "unset";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentRejectedLwinRows = form.get("rejectedLwinRows") as string | null;
        return jsonResponse(200, { alreadyExists: false, batchId: "batch-1" });
      }),
    );

    await confirmChunkedSession({
      plan,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(sentRejectedLwinRows).toBeNull();
  });
});

describe("planChunkedPreview — matchedRows accumulation (item 2)", () => {
  it("accumulates a matchedRows entry, mirroring errorRows' own GLOBAL row-number/chunkIndex/chunkRowNumber convention", async () => {
    const dataRecords = ["Domaine A,Cuvee 1,6"];
    const bytes = new TextEncoder().encode("producer,name,quantity\nDomaine A,Cuvee 1,6\n");
    const file = new File(["producer,name,quantity\nDomaine A,Cuvee 1,6\n"], "cellar.csv", { type: "text/csv" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          summary: { ...ZERO_SUMMARY, totalRows: 1, validRows: 1, matchedRows: 1 },
          rows: [
            {
              rowNumber: 1,
              rowState: "valid",
              lwinStatus: "matched",
              lwinId: "LWIN001",
              lwinScore: 0.92,
              lwinDisplayName: "Domaine A Cuvee One 2020",
              costStatus: "present",
              resolution: "auto",
              rawText: { producer: "Domaine A", name: "Cuvee 1", quantity: "6" },
              raw: { producer: "Domaine A", name: "Cuvee 1", quantity: "6" },
              errors: [],
            },
          ],
        }),
      ),
    );

    const result = await planChunkedPreview(file, "producer,name,quantity", dataRecords, bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.matchedRows).toEqual([
      {
        rowNumber: 1,
        chunkIndex: 1,
        chunkRowNumber: 1,
        lwinId: "LWIN001",
        lwinDisplayName: "Domaine A Cuvee One 2020",
        lwinScore: 0.92,
      },
    ]);
    expect(result.preview.errorRows).toEqual([]);
  });

  it("never accumulates a matchedRows entry for an unmatched row", async () => {
    const dataRecords = ["Domaine A,Cuvee 1,6"];
    const bytes = new TextEncoder().encode("producer,name,quantity\nDomaine A,Cuvee 1,6\n");
    const file = new File(["producer,name,quantity\nDomaine A,Cuvee 1,6\n"], "cellar.csv", { type: "text/csv" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          summary: { ...ZERO_SUMMARY, totalRows: 1, validRows: 1 },
          rows: [
            {
              rowNumber: 1,
              rowState: "valid",
              lwinStatus: "unmatched",
              lwinId: null,
              lwinScore: null,
              lwinDisplayName: null,
              costStatus: "present",
              resolution: "pending",
              rawText: { producer: "Domaine A", name: "Cuvee 1", quantity: "6" },
              raw: { producer: "Domaine A", name: "Cuvee 1", quantity: "6" },
              errors: [],
            },
          ],
        }),
      ),
    );

    const result = await planChunkedPreview(file, "producer,name,quantity", dataRecords, bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.matchedRows).toEqual([]);
  });
});
