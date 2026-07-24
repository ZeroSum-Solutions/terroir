import { describe, expect, it, vi } from "vitest";

const mockExtractOcr = vi.fn();
const mockExtractFromOcr = vi.fn();
vi.mock("@/adapters/ocr/azure-document-intelligence", () => ({
  OcrError: class OcrError extends Error {},
  extractOcr: (...args: unknown[]) => mockExtractOcr(...args),
}));
vi.mock("@/adapters/llm/anthropic-invoice-extraction", () => ({
  AiExtractError: class AiExtractError extends Error {},
  extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { processInvoiceScanOnce } = await import("./invoice-scan-service");

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
    const supabase = {
      from: vi.fn(() => ({
        update: vi.fn(() => ({
          eq: vi.fn(async () => {
            updateCount += 1;
            return {
              data: null,
              error: updateCount === 1 ? completionError : null,
            };
          }),
        })),
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
