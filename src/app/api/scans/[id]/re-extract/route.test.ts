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

const SCAN_UPDATED_AT = "2026-08-23T00:00:00.000Z";

function makeSupabase(options: {
  fetch?: { data: unknown; error: unknown };
  /** C14: rows the fenced UPDATE ... .select("id") returns. Default: one row (fence matched). */
  update?: { data?: unknown; error: unknown };
  updateThrows?: boolean;
} = {}) {
  const filters: Array<[string, string]> = [];
  const builder = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
    then: (resolve: (value: { data?: unknown; error: unknown }) => void) =>
      Promise.resolve(options.update ?? { data: [{ id: SCAN_ID }], error: null }).then(resolve),
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
        updated_at: SCAN_UPDATED_AT,
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
      ["updated_at", SCAN_UPDATED_AT],
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

  describe("C14: concurrency fence on updated_at", () => {
    it("returns 409 scan_superseded when the fenced update matches zero rows (another re-extract landed first)", async () => {
      const db = makeSupabase({ update: { data: [], error: null } });
      authorize(db.supabase);

      const response = await call();

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "scan_superseded",
          message: "Scan was updated by another request while this re-extraction was running.",
        },
      });
    });

    it("fences the update on the updated_at value read at fetch time", async () => {
      const { filters, supabase } = makeSupabase();
      authorize(supabase);

      await call();

      expect(filters).toContainEqual(["updated_at", SCAN_UPDATED_AT]);
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

    it("falls back to the first extraction when the retry call throws, without attempting a third call (Grok-5: a transient retry failure must not discard a usable first extraction)", async () => {
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
      // The first extraction's (already-failing) arithmetic routes to
      // human review — never treated as a request failure.
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.arithmetic.ok).toBe(false);

      const update = db.builder.update.mock.calls[0][0];
      expect(update).toMatchObject({ status: "review", accuracy_score: 0 });
      // The first extraction's line items are what gets persisted, never
      // wiped by the failed retry.
      expect(update.final_line_items).toHaveLength(1);
    });

    it("keeps the first extraction when the retry returns no line items (Grok-5: an empty retry must never wipe stored line items with [])", async () => {
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
        .mockResolvedValueOnce({
          distributor: "Test Importer",
          invoiceNumber: "INV-42",
          invoiceDate: "2026-07-12",
          lineItems: [],
        });

      const response = await call();

      expect(extraction.extractFromOcr).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toHaveLength(1);
      expect(body.arithmetic.ok).toBe(false);

      const update = db.builder.update.mock.calls[0][0];
      expect(update).toMatchObject({ status: "review", accuracy_score: 0 });
      expect(update.parsed_line_items).toHaveLength(1);
      expect(update.final_line_items).toHaveLength(1);
    });
  });
});
