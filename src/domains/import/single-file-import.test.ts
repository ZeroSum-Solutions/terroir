// The plain (<= MAX_ROWS) path's request payloads. Both calls used to be
// inline in ImportClient's own handlers, so the exact multipart body could
// only be asserted by rendering the component and driving a click.
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmSingleFileImport, requestSingleFilePreview } from "./single-file-import";
import type { PreviewRow } from "./preview-service";
import type { CanonicalHeader } from "./constants";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const BLANK: Record<CanonicalHeader, string> = {
  producer: "",
  name: "",
  vintage: "",
  varietal: "",
  region: "",
  country: "",
  size_ml: "",
  format: "",
  currency: "",
  quantity: "",
  unit_cost: "",
  bin: "",
  section: "",
};

function previewRow(rowNumber: number, lwinScore: number, lwinDisplayName: string | null): PreviewRow {
  return {
    rowNumber,
    rowState: "valid",
    errors: [],
    rawText: BLANK,
    lwinStatus: "matched",
    lwinId: `LWIN-${rowNumber}`,
    lwinDisplayName,
    lwinScore,
    costStatus: "present",
    resolution: "auto",
  } as unknown as PreviewRow;
}

const FILE = new File(["producer,name\nA,B\n"], "cellar.csv", { type: "text/csv" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestSingleFilePreview", () => {
  it("returns the parsed preview body on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { rows: [], summary: { totalRows: 0 } })));
    const result = await requestSingleFilePreview(FILE);
    expect(result).toEqual({ ok: true, preview: { rows: [], summary: { totalRows: 0 } } });
  });

  it("surfaces the server's own message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: { message: "Too many rows." } })));
    expect(await requestSingleFilePreview(FILE)).toEqual({ ok: false, error: "Too many rows." });
  });
});

describe("confirmSingleFileImport", () => {
  async function capture(args: Parameters<typeof confirmSingleFileImport>[0]) {
    let sent: FormData | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = init?.body as FormData;
        return jsonResponse(201, { batchId: "batch-1" });
      }),
    );
    const result = await confirmSingleFileImport(args);
    return { result, sent: sent as unknown as FormData };
  }

  it("always sends approvedLwinRows once a preview exists, even when it is empty", async () => {
    const { sent } = await capture({
      file: FILE,
      rowOverrides: {},
      rejectedLwinRows: new Set(),
      previewRows: [],
    });
    expect(sent.get("approvedLwinRows")).toBe("{}");
  });

  it("omits approvedLwinRows entirely when there was no preview to show the operator", async () => {
    const { sent } = await capture({
      file: FILE,
      rowOverrides: {},
      rejectedLwinRows: new Set(),
      previewRows: null,
    });
    expect(sent.get("approvedLwinRows")).toBeNull();
  });

  it("echoes back only the apply-eligible, identified matches the operator was shown", async () => {
    const { sent } = await capture({
      file: FILE,
      rowOverrides: {},
      rejectedLwinRows: new Set(),
      previewRows: [previewRow(1, 0.9, "Domaine A 2020"), previewRow(2, 0.4, "Weak"), previewRow(3, 0.9, null)],
    });
    expect(JSON.parse(sent.get("approvedLwinRows") as string)).toEqual({ "1": "LWIN-1" });
  });

  it("omits empty override and rejection payloads rather than sending empty ones", async () => {
    const { sent } = await capture({
      file: FILE,
      rowOverrides: {},
      rejectedLwinRows: new Set(),
      previewRows: [],
    });
    expect(sent.get("rowOverrides")).toBeNull();
    expect(sent.get("rejectedLwinRows")).toBeNull();
  });

  it("sends the operator's overrides and rejections when there are any", async () => {
    const { sent, result } = await capture({
      file: FILE,
      rowOverrides: { 1: { quantity: "6" } },
      rejectedLwinRows: new Set([2, 3]),
      previewRows: [],
    });
    expect(sent.get("rowOverrides")).toBe(JSON.stringify({ 1: { quantity: "6" } }));
    expect(JSON.parse(sent.get("rejectedLwinRows") as string)).toEqual([2, 3]);
    expect(result).toEqual({ ok: true, batchId: "batch-1" });
  });

  it("surfaces a conflict verbatim, with no client-side escalation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: { code: "multiple_live_batches", message: "Two live batches." } })),
    );
    expect(
      await confirmSingleFileImport({ file: FILE, rowOverrides: {}, rejectedLwinRows: new Set(), previewRows: null }),
    ).toEqual({ ok: false, error: "Two live batches." });
  });
});
