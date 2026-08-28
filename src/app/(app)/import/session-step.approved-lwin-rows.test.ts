// BLOCK 2 (Sol audit round 3, finding 2), chunked path — mirrors
// session-step.rejected-lwin-rows.test.ts's own structure exactly:
// localizeApprovedLwinRows is the approvedLwinRows counterpart to
// localizeRowOverrides/localizeRejectedLwinRows, and confirmChunkedSession
// must attach only each chunk's own localized slice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmChunkedSession, localizeApprovedLwinRows, type ChunkPlanItem, type ChunkedPlanState } from "./session-step";

describe("localizeApprovedLwinRows", () => {
  it("keeps only the approved rows that fall inside the chunk's [startRow, endRow] range, translated to local indices", () => {
    const approved = { 1: "LWIN001", 101: "LWIN101", 150: "LWIN150", 200: "LWIN200" };
    const chunk = { startRow: 101, endRow: 150 };
    expect(localizeApprovedLwinRows(approved, chunk)).toEqual({ "1": "LWIN101", "50": "LWIN150" });
  });

  it("returns an empty object when no approved rows fall inside the chunk", () => {
    expect(localizeApprovedLwinRows({ 1: "LWIN001" }, { startRow: 101, endRow: 200 })).toEqual({});
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmChunkedSession — approvedLwinRows wiring", () => {
  it("attaches only the localized slice of approved rows relevant to each chunk's own form data", async () => {
    const chunks: ChunkPlanItem[] = [
      { index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" },
      { index: 2, startRow: 3, endRow: 4, text: "producer,name,quantity\nA,D,1\nA,E,1\n" },
    ];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 2, chunks, sourceSha256: "a".repeat(64) };
    const sentApprovedLwinRows: Array<string | null> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentApprovedLwinRows.push((form.get("approvedLwinRows") as string | null) ?? null);
        return jsonResponse(200, { alreadyExists: false, batchId: `batch-${form.get("chunkIndex")}` });
      }),
    );

    const result = await confirmChunkedSession({
      plan,
      initialUpload: chunks.map((c) => ({ index: c.index, status: "pending" as const, batchId: null, error: null, code: null })),
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      approvedLwinRows: { 1: "LWIN001", 4: "LWIN004" },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(result.ok).toBe(true);
    expect(sentApprovedLwinRows[0]).toBe(JSON.stringify({ "1": "LWIN001" }));
    // Chunk 2 (rows 3-4): global row 4 -> local row 2. No approval for
    // row 3, so only row 2 is sent.
    expect(sentApprovedLwinRows[1]).toBe(JSON.stringify({ "2": "LWIN004" }));
  });

  it("omits the approvedLwinRows field entirely for a chunk with no relevant approvals", async () => {
    const chunks: ChunkPlanItem[] = [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" }];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 1, chunks, sourceSha256: "a".repeat(64) };
    let sentApprovedLwinRows: string | null = "unset";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentApprovedLwinRows = form.get("approvedLwinRows") as string | null;
        return jsonResponse(200, { alreadyExists: false, batchId: "batch-1" });
      }),
    );

    await confirmChunkedSession({
      plan,
      initialUpload: [{ index: 1, status: "pending", batchId: null, error: null, code: null }],
      existingSessionId: null,
      fileLabel: "cellar.csv",
      timestampsRef: { current: [] },
      approvedLwinRows: { 99: "LWIN099" },
      onSessionId: () => {},
      onProgress: () => {},
    });

    expect(sentApprovedLwinRows).toBeNull();
  });

  it("omits the field entirely when approvedLwinRows is not provided at all (plain overrides-only callers keep working)", async () => {
    const chunks: ChunkPlanItem[] = [{ index: 1, startRow: 1, endRow: 2, text: "producer,name,quantity\nA,B,1\nA,C,1\n" }];
    const plan: ChunkedPlanState = { headerRecord: "producer,name,quantity", chunkTotal: 1, chunks, sourceSha256: "a".repeat(64) };
    let sentApprovedLwinRows: string | null = "unset";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/import/sessions")) return jsonResponse(201, { sessionId: "session-new" });
        const form = init?.body as FormData;
        sentApprovedLwinRows = form.get("approvedLwinRows") as string | null;
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

    expect(sentApprovedLwinRows).toBeNull();
  });
});
