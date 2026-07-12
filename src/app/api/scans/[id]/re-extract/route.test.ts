import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => auth.getAuthContext(...args),
}));

const anthropic = vi.hoisted(() => ({ getAnthropicClient: vi.fn() }));
vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: (...args: unknown[]) => anthropic.getAnthropicClient(...args),
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

function makeSupabase() {
  const builder = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.single.mockResolvedValue({
    data: {
      id: "scan-1",
      ocr_text: {
        rawText: "1 x Barolo magnum EUR 95",
        tables: [],
      },
    },
    error: null,
  });

  return {
    builder,
    supabase: { from: vi.fn().mockReturnValue(builder) },
  };
}

describe("POST /api/scans/[id]/re-extract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anthropic.getAnthropicClient.mockReturnValue({});
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

  it("preserves currency and bottle format in the response and persisted items", async () => {
    const { builder, supabase } = makeSupabase();
    auth.getAuthContext.mockResolvedValue({
      supabase,
      restaurantId: "restaurant-1",
    });

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1/re-extract", {
        method: "POST",
      }) as NextRequest,
      { params: Promise.resolve({ id: "scan-1" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ currency: "EUR", format: "1.5L" });

    expect(builder.update).toHaveBeenCalledOnce();
    const update = builder.update.mock.calls[0][0];
    expect(update.final_line_items[0]).toMatchObject({
      currency: "EUR",
      format: "1.5L",
    });
  });
});
