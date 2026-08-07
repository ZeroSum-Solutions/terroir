/**
 * Unit tests for `extractOcr` (BND-011).
 *
 * The Azure SDK is mocked at the `@/lib/scanner/azure` module boundary.
 * vi.mock factories are hoisted — so we use `vi.hoisted(...)` to declare
 * the shared mock function and resolve it lazily from the factory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OcrResult } from "./ocr-service";

const azure = vi.hoisted(() => ({ analyzeInvoice: vi.fn() }));
vi.mock("./azure", () => ({
  analyzeInvoice: (...args: unknown[]) => azure.analyzeInvoice(...args),
}));

const { extractOcr, OcrError } = await import("./ocr-service");

function okOcr(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    rawText: "Invoice #123\nLine 1 ...\nLine 2 ...",
    vendorName: "Test Distributor",
    invoiceNumber: "INV-1001",
    invoiceDate: "2026-04-01",
    tables: [
      { description: "Pinot Noir", quantity: 6, unitPrice: 32.5, amount: 195 },
    ],
    ...overrides,
  };
}

describe("extractOcr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT = "https://example.invalid";
    process.env.AZURE_DOC_INTELLIGENCE_KEY = "test-key";
  });

  it("returns the Azure result verbatim on success", async () => {
    const result = okOcr();
    azure.analyzeInvoice.mockResolvedValue(result);

    const got = await extractOcr(Buffer.from("stub"), "application/pdf");

    expect(got).toBe(result);
    expect(azure.analyzeInvoice).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
    );
  });

  it("throws OcrError('not_configured') when AZURE_DOC_INTELLIGENCE_ENDPOINT is missing", async () => {
    delete process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT;

    await expect(
      extractOcr(Buffer.from("stub"), "application/pdf"),
    ).rejects.toMatchObject({
      name: "OcrError",
      code: "not_configured",
    });
    // Never reaches Azure.
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  it("throws OcrError('not_configured') when AZURE_DOC_INTELLIGENCE_KEY is missing", async () => {
    delete process.env.AZURE_DOC_INTELLIGENCE_KEY;

    await expect(
      extractOcr(Buffer.from("stub"), "application/pdf"),
    ).rejects.toMatchObject({
      name: "OcrError",
      code: "not_configured",
    });
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  it("classifies upstream failures without returning provider detail", async () => {
    azure.analyzeInvoice.mockRejectedValue({
      status: 503,
      message: "Azure DI private response",
    });

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OcrError);
    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(
      "Invoice text extraction is temporarily unavailable. Please try again.",
    );
    expect(err.message).not.toContain("private");
  });

  it("keeps unclassified provider values redacted at the upstream boundary", async () => {
    azure.analyzeInvoice.mockRejectedValue("some primitive");

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OcrError);
    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe(
      "Invoice text extraction is temporarily unavailable. Please try again.",
    );
  });

  it.each([
    [{ status: 429 }, "rate_limited", true],
    [{ name: "TimeoutError" }, "timeout", true],
    [{ status: 422 }, "bad_input", false],
  ] as const)("maps provider failures into the retry taxonomy", async (failure, code, retryable) => {
    azure.analyzeInvoice.mockRejectedValue(failure);

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((error) => error);

    expect(err).toBeInstanceOf(OcrError);
    expect(err).toMatchObject({ code, retryable });
  });

  it("throws OcrError('empty_text') when Azure returns a blank rawText", async () => {
    azure.analyzeInvoice.mockResolvedValue(okOcr({ rawText: "   \n\t  " }));

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OcrError);
    expect(err.code).toBe("empty_text");
  });
});
