import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createIdempotencyRequestHash } from "@/lib/api/idempotency";

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
  claim?: unknown;
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

  const rpc = vi.fn((name: string) => {
    if (name === "claim_api_idempotency") {
      return Promise.resolve({
        data: options.claim ?? [{ outcome: "claimed" }],
        error: null,
      });
    }
    if (name === "complete_api_idempotency") {
      return Promise.resolve({ data: true, error: null });
    }
    return Promise.resolve({ data: true, error: null });
  });

  return {
    builder,
    filters,
    rpc,
    supabase: { from: vi.fn().mockReturnValue(builder), rpc },
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

  function call(key?: string) {
    return POST(
      new Request(
        `http://localhost/api/scans/${SCAN_ID}/re-extract`,
        {
          method: "POST",
          headers: key ? { "Idempotency-Key": key } : {},
        },
      ) as NextRequest,
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
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

  it("maps provider timeout to a nested redacted 504", async () => {
    const db = makeSupabase();
    authorize(db.supabase);
    extraction.extractFromOcr.mockRejectedValue(
      new AiExtractError("timeout", "provider-specific timeout detail", true),
    );

    const response = await call();

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: {
        code: "provider_timeout",
        message: "Extraction provider timed out.",
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

  it("binds keyed extraction to the normalized scan ID", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call("scan_reextract_key_0001");

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(db.rpc).toHaveBeenNthCalledWith(1, "claim_api_idempotency", {
      p_restaurant_id: RESTAURANT_ID,
      p_operation_id: "api:POST:/api/scans/{param}/re-extract",
      p_idempotency_key: "scan_reextract_key_0001",
      p_request_hash: createIdempotencyRequestHash({ id: SCAN_ID }),
    });
    expect(extraction.extractFromOcr).toHaveBeenCalledOnce();
  });

  it("replays keyed extraction without calling the provider or updating", async () => {
    const replayBody = {
      scanId: SCAN_ID,
      items: [{ id: "persisted-line" }],
      quality: { avgConfidence: 0.98 },
      rawText: "stored",
    };
    const db = makeSupabase({
      claim: [
        {
          outcome: "replay",
          response_status: 200,
          response_headers: {},
          response_body: replayBody,
        },
      ],
    });
    authorize(db.supabase);

    const response = await call("scan_reextract_key_0002");

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(extraction.extractFromOcr).not.toHaveBeenCalled();
    expect(db.builder.update).not.toHaveBeenCalled();
  });

  it("rejects malformed keys before provider or database work", async () => {
    const db = makeSupabase();
    authorize(db.supabase);

    const response = await call("bad key!");

    expect(response.status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(extraction.extractFromOcr).not.toHaveBeenCalled();
    expect(db.builder.select).not.toHaveBeenCalled();
  });
});
