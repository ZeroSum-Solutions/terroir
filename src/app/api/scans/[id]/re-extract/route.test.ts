import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { INVOICE_EXTRACTION_RETRY } from "@/lib/ai/models";

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => auth.requireMembership(...args),
}));

const extraction = vi.hoisted(() => ({ extractFromOcr: vi.fn() }));
vi.mock("@/lib/scanner/ai-extract", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scanner/ai-extract")>();
  return {
    ...original,
    extractFromOcr: (...args: unknown[]) => extraction.extractFromOcr(...args),
  };
});

const { POST } = await import("./route");
const { AiExtractError } = await import("@/lib/scanner/ai-extract");
const SCAN_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

function makeSupabase(options: {
  fetch?: { data: unknown; error: unknown };
  update?: { error: unknown };
  updateThrows?: boolean;
} = {}) {
  const filters: Array<[string, string]> = [];
  const builder = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
    then: (resolve: (value: { error: unknown }) => void) =>
      Promise.resolve(options.update ?? { error: null }).then(resolve),
  };
  builder.select.mockReturnValue(builder);
  builder.update.mockImplementation(() => {
    if (options.updateThrows) throw new Error("update threw");
    return builder;
  });
  builder.eq.mockImplementation((column: string, value: string) => {
    filters.push([column, value]);
    return builder;
  });
  builder.single.mockResolvedValue(
    options.fetch ?? {
      data: {
        id: SCAN_ID,
        ocr_text: {
          rawText: "1 x Barolo magnum EUR 95",
          tables: [],
        },
      },
      error: null,
    },
  );

  return {
    builder,
    filters,
    supabase: { from: vi.fn().mockReturnValue(builder) },
  };
}

describe("POST /api/scans/[id]/re-extract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extraction.extractFromOcr.mockResolvedValue({
      distributor: "Test Importer",
      invoiceNumber: "INV-42",
      invoiceDate: "2026-07-12",
      lineItems: [
        {
          name: "Barolo",
          producer: "Test Producer",
          vintage: 2019,
          varietal: "Nebbiolo",
          region: "Piedmont",
          qty: 1,
          unitCost: 95,
          currency: "EUR",
          format: "1.5L",
          confidence: 0.98,
          lowFields: [],
        },
      ],
    });
  });

  function authorize(supabase: unknown) {
    auth.requireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      user: { id: "33333333-3333-4333-8333-333333333333" },
      role: "staff",
    });
  }

  function call() {
    return POST({} as NextRequest, {
      params: Promise.resolve({ id: SCAN_ID }),
    });
  }

  it("preserves currency and bottle format in the response and persisted items", async () => {
    const { builder, filters, supabase } = makeSupabase();
    authorize(supabase);

    const response = await call();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ currency: "EUR", format: "1.5L" });

    expect(builder.update).toHaveBeenCalledOnce();
    const update = builder.update.mock.calls[0][0];
    expect(update.final_line_items[0]).toMatchObject({
      currency: "EUR",
      format: "1.5L",
    });
    expect(filters).toEqual([
      ["id", SCAN_ID],
      ["restaurant_id", RESTAURANT_ID],
      ["id", SCAN_ID],
      ["restaurant_id", RESTAURANT_ID],
    ]);
  });

  it("distinguishes a missing scan from a lookup provider failure", async () => {
    const missing = makeSupabase({
      fetch: { data: null, error: { code: "PGRST116", message: "no rows" } },
    });
    authorize(missing.supabase);
    expect((await call()).status).toBe(404);

    const failed = makeSupabase({
      fetch: {
        data: null,
        error: { code: "XX000", message: "private database detail" },
      },
    });
    authorize(failed.supabase);
    const response = await call();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });

  it("redacts malformed stored OCR before calling the provider", async () => {
    const db = makeSupabase({
      fetch: {
        data: { id: SCAN_ID, ocr_text: "{\"rawText\":" },
        error: null,
      },
    });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(extraction.extractFromOcr).not.toHaveBeenCalled();
  });

  it("returns a nested 422 when the scan has no stored OCR", async () => {
    const db = makeSupabase({
      fetch: {
        data: { id: SCAN_ID, ocr_text: null },
        error: null,
      },
    });
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "missing_ocr_text",
        message: "Scan has no stored OCR text to re-extract.",
      },
    });
    expect(extraction.extractFromOcr).not.toHaveBeenCalled();
  });

  it("keeps raw OCR only in nested details for parse fallback", async () => {
    const db = makeSupabase();
    authorize(db.supabase);
    extraction.extractFromOcr.mockRejectedValue(
      new AiExtractError("parse_failed", "provider-specific detail"),
    );

    const response = await call();

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "parse_failed",
        message: "Unable to extract wines from stored OCR.",
        details: { rawText: "1 x Barolo magnum EUR 95" },
      },
    });
  });

  it("maps provider throttling to a nested redacted 429", async () => {
    const db = makeSupabase();
    authorize(db.supabase);
    extraction.extractFromOcr.mockRejectedValue(
      new AiExtractError("rate_limited", "provider-specific detail"),
    );

    const response = await call();

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Extraction provider rate limited.",
      },
    });
  });

  it.each([
    ["returned", { update: { error: { message: "private update detail" } } }],
    ["thrown", { updateThrows: true }],
  ])("never returns success when the scan update %s fails", async (_name, options) => {
    const db = makeSupabase(options);
    authorize(db.supabase);

    const response = await call();

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });

  describe("G1-12 arithmetic retry-then-review gate", () => {
    function reconciledLine(overrides: Record<string, unknown> = {}) {
      return {
        name: "Barolo",
        producer: "Test Producer",
        vintage: 2019,
        varietal: "Nebbiolo",
        region: "Piedmont",
        qty: 1,
        unitCost: 95,
        lineTotal: 95,
        currency: "EUR",
        format: "1.5L",
        confidence: 0.98,
        lowFields: [],
        ...overrides,
      };
    }

    it("retries once at higher effort, then marks the scan for review when the retry still fails", async () => {
      const db = makeSupabase();
      authorize(db.supabase);
      // First pass: unit cost misread (95 -> 60) against a correctly-read
      // line total. Retry returns the same mismatch — never corrects itself.
      extraction.extractFromOcr.mockReset();
      extraction.extractFromOcr
        .mockResolvedValueOnce({
          distributor: "Test Importer",
          invoiceNumber: "INV-42",
          invoiceDate: "2026-07-12",
          lineItems: [reconciledLine({ unitCost: 60 })],
        })
        .mockResolvedValueOnce({
          distributor: "Test Importer",
          invoiceNumber: "INV-42",
          invoiceDate: "2026-07-12",
          lineItems: [reconciledLine({ unitCost: 60 })],
        });

      const response = await call();

      expect(extraction.extractFromOcr).toHaveBeenCalledTimes(2);
      expect(extraction.extractFromOcr.mock.calls[1][1]).toEqual(
        INVOICE_EXTRACTION_RETRY,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.arithmetic.ok).toBe(false);
      expect(body.quality.manualFallbackTriggered).toBe(true);
      expect(body.quality.reason).toBe("arithmetic_mismatch");

      const update = db.builder.update.mock.calls[0][0];
      expect(update).toMatchObject({ status: "review", accuracy_score: 0 });
    });

    it("does not retry when the extraction already reconciles", async () => {
      const db = makeSupabase();
      authorize(db.supabase);
      extraction.extractFromOcr.mockReset();
      extraction.extractFromOcr.mockResolvedValueOnce({
        distributor: "Test Importer",
        invoiceNumber: "INV-42",
        invoiceDate: "2026-07-12",
        lineItems: [reconciledLine()],
      });

      const response = await call();

      expect(extraction.extractFromOcr).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.arithmetic.ok).toBe(true);

      const update = db.builder.update.mock.calls[0][0];
      expect(update).toMatchObject({ status: "complete" });
    });

    it("propagates a transient retry-call error without attempting a third call", async () => {
      const db = makeSupabase();
      authorize(db.supabase);
      extraction.extractFromOcr.mockReset();
      extraction.extractFromOcr
        .mockResolvedValueOnce({
          distributor: "Test Importer",
          invoiceNumber: "INV-42",
          invoiceDate: "2026-07-12",
          lineItems: [reconciledLine({ unitCost: 60 })],
        })
        .mockRejectedValueOnce(
          new AiExtractError("rate_limited", "provider-specific detail"),
        );

      const response = await call();

      expect(extraction.extractFromOcr).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(429);
      expect(db.builder.update).not.toHaveBeenCalled();
    });
  });
});
