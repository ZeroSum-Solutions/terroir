import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExtractOcr = vi.fn();
const mockExtractFromOcr = vi.fn();
vi.mock("@/adapters/ocr/azure-document-intelligence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/adapters/ocr/azure-document-intelligence")>();
  return {
    ...actual,
    OcrError: class OcrError extends Error {},
    extractOcr: (...args: unknown[]) => mockExtractOcr(...args),
  };
});
vi.mock("@/adapters/llm/anthropic-invoice-extraction", () => ({
  AiExtractError: class AiExtractError extends Error {},
  extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { processInvoiceScanOnce } = await import("./invoice-scan-service");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processInvoiceScanOnce persistence boundary", () => {
  it("does not claim success when the final scan update fails", async () => {
    const completionError = {
      code: "XX000",
      message: "super-secret completion failure",
    };
    mockExtractOcr.mockResolvedValue({
      rawText: "invoice text",
      tables: [],
    });
    mockExtractFromOcr.mockResolvedValue({
      distributor: "Distributor",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-07-24",
      lineItems: [
        {
          name: "Volnay",
          producer: "Domaine Test",
          vintage: 2022,
          varietal: "Pinot Noir",
          region: "Burgundy",
          qty: 1,
          unitCost: 42,
          currency: "USD",
          format: "750ml",
          confidence: 0.99,
          lowFields: [],
        },
      ],
    });
    let updateCount = 0;
    // Chainable AND directly awaitable, matching real supabase-js query
    // builders: the persist write chains .eq().eq().select(), the
    // catch-path failed write chains only .eq().eq() with no .select().
    function updateResult(result: { data: unknown; error: unknown }) {
      const node: Record<string, unknown> = {};
      node.eq = vi.fn(() => node);
      node.select = vi.fn(() => node);
      node.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject);
      return node;
    }
    const supabase = {
      from: vi.fn(() => ({
        update: vi.fn(() => {
          updateCount += 1;
          return updateResult({
            data: updateCount === 1 ? null : [],
            error: updateCount === 1 ? completionError : null,
          });
        }),
      })),
    };

    await expect(
      processInvoiceScanOnce({
        supabase: supabase as never,
        restaurantId: "restaurant-a",
        userId: "user-a",
        fileBuffer: Buffer.from("invoice"),
        mimeType: "image/jpeg",
        preCreatedScanId: "scan-a",
      }),
    ).rejects.toBe(completionError);
    expect(updateCount).toBe(2);
  });
});

describe("processInvoiceScanOnce catch-path recovery data (C04)", () => {
  function captureUpdateResult() {
    const node: Record<string, unknown> = {};
    node.eq = vi.fn(() => node);
    node.select = vi.fn(() => node);
    node.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return node;
  }

  it("persists ocr_text on the fenced failure write when OCR already succeeded but extraction threw", async () => {
    mockExtractOcr.mockResolvedValue({ rawText: "invoice text", tables: [] });
    mockExtractFromOcr.mockRejectedValue(new Error("extraction boom"));

    const updatePayloads: Record<string, unknown>[] = [];
    const supabase = {
      from: vi.fn(() => ({
        update: vi.fn((payload: Record<string, unknown>) => {
          updatePayloads.push(payload);
          return captureUpdateResult();
        }),
      })),
    };

    await expect(
      processInvoiceScanOnce({
        supabase: supabase as never,
        restaurantId: "restaurant-a",
        userId: "user-a",
        fileBuffer: Buffer.from("invoice"),
        mimeType: "image/jpeg",
        preCreatedScanId: "scan-a",
      }),
    ).rejects.toThrow("extraction boom");

    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0].status).toBe("failed");
    expect(updatePayloads[0].ocr_text).toMatchObject({ rawText: "invoice text" });
  });

  it("does NOT fabricate ocr_text on the fenced failure write when OCR itself failed", async () => {
    mockExtractOcr.mockRejectedValue(new Error("ocr boom"));

    const updatePayloads: Record<string, unknown>[] = [];
    const supabase = {
      from: vi.fn(() => ({
        update: vi.fn((payload: Record<string, unknown>) => {
          updatePayloads.push(payload);
          return captureUpdateResult();
        }),
      })),
    };

    await expect(
      processInvoiceScanOnce({
        supabase: supabase as never,
        restaurantId: "restaurant-a",
        userId: "user-a",
        fileBuffer: Buffer.from("invoice"),
        mimeType: "image/jpeg",
        preCreatedScanId: "scan-a",
      }),
    ).rejects.toThrow("ocr boom");

    expect(updatePayloads).toHaveLength(1);
    // status_reason (SCAN-04 / D6 rule 1, migration 0143): the row stays in
    // the ledger, so it has to say why. A plain Error is not an OcrError or
    // an AiExtractError, so the stage is genuinely unknown here.
    expect(updatePayloads[0]).toEqual({ status: "failed", status_reason: "unexpected_error" });
  });

  it("names the failing stage in status_reason for a typed OCR failure", async () => {
    // With the vision fallback on, an OCR failure is no longer a scan
    // failure (invoice-extraction-stage.ts); this test is about what gets
    // persisted when OCR IS the terminal failure, so switch it off here.
    process.env.INVOICE_VISION_FALLBACK = "off";
    const { OcrError } = await import("@/adapters/ocr/azure-document-intelligence");
    // The module mock replaces OcrError with a bare `extends Error` class,
    // so the real constructor's code argument is dropped — set it back.
    const ocrFailure = new OcrError("upstream_error", "azure down") as Error & { code?: string };
    ocrFailure.code = "upstream_error";
    mockExtractOcr.mockRejectedValue(ocrFailure);

    const updatePayloads: Record<string, unknown>[] = [];
    const supabase = {
      from: vi.fn(() => ({
        update: vi.fn((payload: Record<string, unknown>) => {
          updatePayloads.push(payload);
          return captureUpdateResult();
        }),
      })),
    };

    const result = await processInvoiceScanOnce({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      userId: "user-a",
      fileBuffer: Buffer.from("invoice"),
      mimeType: "image/jpeg",
      preCreatedScanId: "scan-a",
    });

    expect(result.status).toBe(502);
    expect(updatePayloads[0]).toEqual({
      status: "failed",
      status_reason: "ocr_upstream_error",
    });
  });
});

describe("processInvoiceScanOnce multi-page batching (BND-081 / TER-CF-032)", () => {
  it("OCRs every page and merges them into one extraction call", async () => {
    mockExtractOcr.mockImplementation(async (buffer: Buffer) =>
      buffer.toString() === "page one"
        ? { rawText: "PAGE ONE RAW TEXT", tables: [] }
        : { rawText: "PAGE TWO RAW TEXT", tables: [] },
    );
    mockExtractFromOcr.mockResolvedValue({
      distributor: "Distributor",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-07-24",
      lineItems: [],
    });
    const supabase = {
      from: vi.fn(() => ({
        update: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })),
      })),
    };

    await processInvoiceScanOnce({
      supabase: supabase as never,
      restaurantId: "restaurant-a",
      userId: "user-a",
      fileBuffer: Buffer.from("page one"),
      mimeType: "image/jpeg",
      extraFiles: [{ buffer: Buffer.from("page two"), mimeType: "image/png" }],
      preCreatedScanId: "scan-a",
    });

    expect(mockExtractOcr).toHaveBeenCalledTimes(2);
    expect(mockExtractOcr).toHaveBeenNthCalledWith(1, Buffer.from("page one"), "image/jpeg");
    expect(mockExtractOcr).toHaveBeenNthCalledWith(2, Buffer.from("page two"), "image/png");
    const mergedOcr = mockExtractFromOcr.mock.calls[0][0];
    expect(mergedOcr.rawText).toContain("PAGE ONE RAW TEXT");
    expect(mergedOcr.rawText).toContain("PAGE TWO RAW TEXT");
  });
});
