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

const { extractOcr, OcrError, mergeOcrResults } = await import("./ocr-service");

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

  it("wraps Azure throws as OcrError('upstream_error') with the original message", async () => {
    azure.analyzeInvoice.mockRejectedValue(new Error("Azure DI 503"));

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OcrError);
    expect(err.code).toBe("upstream_error");
    expect(err.message).toBe("Azure DI 503");
  });

  it("falls back to a generic message when Azure throws a non-Error value", async () => {
    azure.analyzeInvoice.mockRejectedValue("some primitive");

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OcrError);
    expect(err.code).toBe("upstream_error");
    expect(err.message).toBe("Azure OCR failed.");
  });

  it("throws OcrError('empty_text') when Azure returns a blank rawText", async () => {
    azure.analyzeInvoice.mockResolvedValue(okOcr({ rawText: "   \n\t  " }));

    const err = await extractOcr(Buffer.from("stub"), "application/pdf")
      .catch((e) => e);

    expect(err).toBeInstanceOf(OcrError);
    expect(err.code).toBe("empty_text");
  });
});

describe("mergeOcrResults", () => {
  it("returns the single result unchanged when there is only one page", () => {
    const single = okOcr();
    expect(mergeOcrResults([single])).toBe(single);
  });

  it("concatenates raw text and tables across pages, in order", () => {
    const page1 = okOcr({ rawText: "PAGE ONE TEXT", tables: [{ description: "Wine A" }] });
    const page2 = okOcr({ rawText: "PAGE TWO TEXT", tables: [{ description: "Wine B" }] });

    const merged = mergeOcrResults([page1, page2]);

    expect(merged.rawText).toContain("PAGE ONE TEXT");
    expect(merged.rawText).toContain("PAGE TWO TEXT");
    expect(merged.rawText.indexOf("PAGE ONE TEXT")).toBeLessThan(
      merged.rawText.indexOf("PAGE TWO TEXT"),
    );
    expect(merged.tables).toEqual([
      { description: "Wine A" },
      { description: "Wine B" },
    ]);
  });

  it("takes the first non-empty header field across pages", () => {
    const page1 = okOcr({ vendorName: undefined, invoiceNumber: undefined, invoiceDate: undefined });
    const page2 = okOcr({ vendorName: "Distributor Co", invoiceNumber: "INV-77", invoiceDate: "2026-05-01" });

    const merged = mergeOcrResults([page1, page2]);

    expect(merged.vendorName).toBe("Distributor Co");
    expect(merged.invoiceNumber).toBe("INV-77");
    expect(merged.invoiceDate).toBe("2026-05-01");
  });
});
