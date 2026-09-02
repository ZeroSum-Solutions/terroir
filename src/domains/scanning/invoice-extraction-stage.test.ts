import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExtractOcr = vi.fn();
const mockMerge = vi.fn();
const mockExtractFromOcr = vi.fn();
const mockExtractFromImages = vi.fn();
const mockCaptureMessage = vi.fn();

vi.mock("@/adapters/ocr/azure-document-intelligence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/adapters/ocr/azure-document-intelligence")>();
  return {
    ...actual,
    extractOcr: (...args: unknown[]) => mockExtractOcr(...args),
    mergeOcrResults: (...args: unknown[]) => mockMerge(...args),
  };
});
vi.mock("@/adapters/llm/anthropic-invoice-extraction", () => ({
  extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
  extractFromImages: (...args: unknown[]) => mockExtractFromImages(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: (...args: unknown[]) => mockCaptureMessage(...args), captureException: vi.fn() }));
vi.mock("./scan-telemetry", () => ({ withScanSpan: (_n: string, _a: unknown, fn: () => unknown) => fn() }));

const { OcrError } = await import("@/adapters/ocr/azure-document-intelligence");
const { readInvoicePages } = await import("./invoice-extraction-stage");

const pages = [
  { buffer: Buffer.from("a"), mimeType: "image/jpeg" },
  { buffer: Buffer.from("b"), mimeType: "image/jpeg" },
];
const merged = { rawText: "merged", tables: [] };
const parsed = { distributor: "D", invoiceNumber: null, invoiceDate: null, lineItems: [] };

/**
 * The invoice pipeline used to be OCR-or-nothing: with Azure unconfigured
 * (local, staging) or its resource gone (production since #116 — the
 * endpoint no longer resolves) every invoice scan died at the first stage.
 * The vision models already read the photo directly; this stage falls back
 * to that, visibly, and keeps the retry on the same path.
 */
describe("readInvoicePages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INVOICE_VISION_FALLBACK;
    mockMerge.mockReturnValue(merged);
    mockExtractFromOcr.mockResolvedValue(parsed);
    mockExtractFromImages.mockResolvedValue(parsed);
  });

  it("OCR available: merges every page and extracts from the text", async () => {
    mockExtractOcr.mockResolvedValue({ rawText: "page", tables: [] });
    const stage = await readInvoicePages(pages);
    expect(stage.source).toBe("ocr");
    expect(mockExtractOcr).toHaveBeenCalledTimes(2);
    expect(stage.ocr).toBe(merged);
    await stage.extract();
    expect(mockExtractFromOcr).toHaveBeenCalledWith(merged, undefined);
    expect(mockExtractFromImages).not.toHaveBeenCalled();
  });

  it("OCR not configured: extracts from the images instead and says so", async () => {
    mockExtractOcr.mockRejectedValue(new OcrError("not_configured", "no azure"));
    const stage = await readInvoicePages(pages);
    expect(stage.source).toBe("vision");
    expect(stage.ocr).toEqual({ rawText: "", tables: [], source: "vision" });
    await stage.extract();
    expect(mockExtractFromImages).toHaveBeenCalledWith(pages, undefined);
    expect(mockExtractFromOcr).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("OCR upstream failure (the dead endpoint): same fallback", async () => {
    mockExtractOcr.mockRejectedValue(new OcrError("upstream_error", "getaddrinfo ENOTFOUND"));
    const stage = await readInvoicePages(pages);
    expect(stage.source).toBe("vision");
  });

  it("the arithmetic retry stays on the vision path with its profile", async () => {
    mockExtractOcr.mockRejectedValue(new OcrError("not_configured", "no azure"));
    const stage = await readInvoicePages(pages);
    const retry = { model: "anthropic/claude-sonnet-5", effort: "high" as const, maxTokens: 24000 };
    await stage.extract(retry);
    expect(mockExtractFromImages).toHaveBeenCalledWith(pages, retry);
  });

  it("OCR ran and found no text: not a fallback case, the error stands", async () => {
    mockExtractOcr.mockRejectedValue(new OcrError("empty_text", "blank"));
    await expect(readInvoicePages(pages)).rejects.toBeInstanceOf(OcrError);
    expect(mockExtractFromImages).not.toHaveBeenCalled();
  });

  it("INVOICE_VISION_FALLBACK=off keeps the old OCR-or-nothing behaviour", async () => {
    process.env.INVOICE_VISION_FALLBACK = "off";
    mockExtractOcr.mockRejectedValue(new OcrError("not_configured", "no azure"));
    await expect(readInvoicePages(pages)).rejects.toBeInstanceOf(OcrError);
  });
});
