import { describe, expect, it, vi, beforeEach } from "vitest";
import { INVOICE_EXTRACTION, INVOICE_EXTRACTION_RETRY } from "@/lib/ai/models";

/**
 * G1-12 — retry-then-human-review behavior of the invoice arithmetic gate,
 * exercised through the real service function with a mocked model call.
 * No live API calls: `extractFromOcr` is mocked at the adapter boundary,
 * same pattern as `invoice-scan-service.test.ts`.
 *
 * Fixtures use three line items (not one) so `scoreItems`'s own
 * too-few-items fallback never contaminates the arithmetic-driven
 * `manualFallbackTriggered` assertions below.
 */

class MockAiExtractError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiExtractError";
    this.code = code;
  }
}

const mockExtractOcr = vi.fn();
const mockExtractFromOcr = vi.fn();
vi.mock("@/adapters/ocr/azure-document-intelligence", () => ({
  OcrError: class OcrError extends Error {},
  extractOcr: (...args: unknown[]) => mockExtractOcr(...args),
}));
vi.mock("@/adapters/llm/anthropic-invoice-extraction", () => ({
  AiExtractError: MockAiExtractError,
  extractFromOcr: (...args: unknown[]) => mockExtractFromOcr(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { processInvoiceScanOnce } = await import("./invoice-scan-service");

function lineItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "Volnay",
    producer: "Domaine Test",
    vintage: 2022,
    varietal: "Pinot Noir",
    region: "Burgundy",
    currency: "USD",
    format: "750ml",
    lowFields: [],
    ...overrides,
  };
}

/** Three-line invoice where every line and the invoice total reconcile. */
function reconciledInvoice(confidence = 0.95) {
  return {
    distributor: "Test Distributor",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-07-24",
    lineItems: [
      lineItem({ qty: 6, unitCost: 45, lineTotal: 270, confidence }),
      lineItem({ name: "Barolo", qty: 3, unitCost: 62.5, lineTotal: 187.5, confidence }),
      lineItem({ name: "Chablis", qty: 12, unitCost: 28, lineTotal: 336, confidence }),
    ],
    invoiceTotal: 793.5,
    taxAndFees: null,
  };
}

/** Same invoice, but the third line's unit cost was misread (28 -> 18). */
function mismatchedInvoice(confidence = 0.9) {
  const invoice = reconciledInvoice(confidence);
  invoice.lineItems[2] = lineItem({
    name: "Chablis",
    qty: 12,
    unitCost: 18,
    lineTotal: 336,
    confidence,
  });
  return invoice;
}

function makeSupabase() {
  const updates: Array<Record<string, unknown>> = [];
  const builder = {
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    }),
    eq: vi.fn(async () => ({ data: null, error: null })),
  };
  return {
    updates,
    supabase: { from: vi.fn(() => builder) },
  };
}

async function runScan(supabase: unknown) {
  return processInvoiceScanOnce({
    supabase: supabase as never,
    restaurantId: "restaurant-a",
    userId: "user-a",
    fileBuffer: Buffer.from("invoice"),
    mimeType: "image/jpeg",
    preCreatedScanId: "scan-a",
  });
}

describe("processInvoiceScanOnce — G1-12 arithmetic retry-then-review gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractOcr.mockResolvedValue({ rawText: "invoice text", tables: [] });
  });

  it("does not retry when the first extraction already reconciles", async () => {
    mockExtractFromOcr.mockResolvedValueOnce(reconciledInvoice());
    const { supabase, updates } = makeSupabase();

    const result = await runScan(supabase);

    expect(mockExtractFromOcr).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    const body = result.body as {
      arithmetic: { ok: boolean };
      quality: { manualFallbackTriggered: boolean };
    };
    expect(body.arithmetic.ok).toBe(true);
    expect(body.quality.manualFallbackTriggered).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      status: "complete",
      accuracy_score: 0.95,
    });
  });

  it("retries once at higher effort and persists as complete when the retry reconciles", async () => {
    mockExtractFromOcr
      .mockResolvedValueOnce(mismatchedInvoice())
      .mockResolvedValueOnce(reconciledInvoice(0.97));
    const { supabase, updates } = makeSupabase();

    const result = await runScan(supabase);

    expect(mockExtractFromOcr).toHaveBeenCalledTimes(2);
    expect(mockExtractFromOcr.mock.calls[0][1]).toBeUndefined();
    expect(mockExtractFromOcr.mock.calls[1][1]).toEqual(INVOICE_EXTRACTION_RETRY);
    expect(mockExtractFromOcr.mock.calls[1][1]).not.toEqual(INVOICE_EXTRACTION);

    expect(result.status).toBe(200);
    const body = result.body as {
      arithmetic: { ok: boolean };
      quality: { manualFallbackTriggered: boolean };
    };
    expect(body.arithmetic.ok).toBe(true);
    expect(body.quality.manualFallbackTriggered).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      status: "complete",
      accuracy_score: 0.97,
    });
  });

  it("requires human review and zeroes accuracy_score when the retry still fails arithmetic validation", async () => {
    mockExtractFromOcr
      .mockResolvedValueOnce(mismatchedInvoice())
      .mockResolvedValueOnce(mismatchedInvoice());
    const { supabase, updates } = makeSupabase();

    const result = await runScan(supabase);

    // Exactly one retry — never a third call, regardless of the retry's own outcome.
    expect(mockExtractFromOcr).toHaveBeenCalledTimes(2);

    expect(result.status).toBe(200);
    const body = result.body as {
      arithmetic: { ok: boolean; issues: unknown[] };
      quality: { manualFallbackTriggered: boolean; reason?: string };
    };
    expect(body.arithmetic.ok).toBe(false);
    expect(body.arithmetic.issues.length).toBeGreaterThan(0);
    expect(body.quality.manualFallbackTriggered).toBe(true);
    expect(body.quality.reason).toBe("arithmetic_mismatch");

    expect(updates.at(-1)).toMatchObject({
      status: "review",
      accuracy_score: 0,
    });
  });

  it("propagates a transient retry-call error without attempting a third call (no double-billing)", async () => {
    mockExtractFromOcr
      .mockResolvedValueOnce(mismatchedInvoice())
      .mockRejectedValueOnce(
        new MockAiExtractError("upstream_error", "The AI service encountered an error."),
      );
    const { supabase, updates } = makeSupabase();

    const result = await runScan(supabase);

    expect(mockExtractFromOcr).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(502);
    expect((result.body as { code: string }).code).toBe("upstream_error");
    // Falls back to the existing failure path — never left as "complete".
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });
});
