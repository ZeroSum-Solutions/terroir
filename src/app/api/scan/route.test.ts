import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { OK_OCR } from "@/test/mocks/azure";
import { makeParsedInvoice, makeEmptyParsedInvoice } from "@/test/fixtures/invoices/scans";

/**
 * /api/scan route tests.
 *
 * BND-003 / ARCH-001: requireMembership (not requireAuth) gates the
 * endpoint, and an unauthenticated caller receives a 401 without ever
 * triggering the paid Azure OCR or Anthropic calls.
 *
 * BND-010: characterization coverage — happy path, unauth, missing-file,
 * bad mime, Azure 500, Anthropic 500, plus the BND-007 singleton
 * invariant (constructor never invoked from inside the route).
 *
 * The vi.mock factories below run at file-hoist time, BEFORE any imports
 * are initialized — so they cannot reference imported helpers. See
 * `src/test/mocks/anthropic.ts` for the full rationale.
 */

const auth = vi.hoisted(() => ({ requireMembership: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => auth.requireMembership(...args),
}));

const anthropic = vi.hoisted(() => {
  class APIError extends Error {}
  class RateLimitError extends APIError {}
  class BadRequestError extends APIError {}
  return {
    ctor: vi.fn(),
    parse: vi.fn(),
    create: vi.fn(),
    APIError,
    RateLimitError,
    BadRequestError,
  };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse: anthropic.parse, create: anthropic.create };
    static APIError = anthropic.APIError;
    static RateLimitError = anthropic.RateLimitError;
    static BadRequestError = anthropic.BadRequestError;
    constructor(...args: unknown[]) {
      anthropic.ctor(...args);
    }
  },
}));
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: () => ({ type: "json_schema", schema: {} }),
}));

const azure = vi.hoisted(() => ({ analyzeInvoice: vi.fn() }));
vi.mock("@/lib/scanner/azure", () => ({
  analyzeInvoice: (...args: unknown[]) => azure.analyzeInvoice(...args),
}));

function makeSupabase() { return { from: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: "scan-1" }, error: null }), update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), storage: { from: vi.fn().mockReturnThis(), download: vi.fn().mockRejectedValue(new Error("not found")), upload: vi.fn().mockResolvedValue({ error: null }) }, rpc: vi.fn(), catch: vi.fn().mockReturnThis() }; }

const { POST } = await import("./route");
// Reset the Anthropic singleton between tests so the env-var missing
// scenario is order-independent.
const { __resetAnthropicClientForTests } = await import(
  "@/lib/ai/anthropic-client"
);

function makeFormRequest(formData: FormData) {
  return new Request("http://localhost/api/scan", {
    method: "POST",
    body: formData,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function pdfFile() {
  return new File(["%PDF-1.4 stub"], "invoice.pdf", {
    type: "application/pdf",
  });
}

describe("POST /api/scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAnthropicClientForTests();
    process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT = "https://example.invalid";
    process.env.AZURE_DOC_INTELLIGENCE_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  it("returns 401 when the caller is unauthenticated — and never calls Azure or Anthropic", async () => {
    auth.requireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(401);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
    expect(anthropic.parse).not.toHaveBeenCalled();
    // BND-007 invariant: route does not construct its own client.
    expect(anthropic.ctor).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is authed but has no membership", async () => {
    auth.requireMembership.mockResolvedValue(
      NextResponse.json(
        { error: "No restaurant membership found." },
        { status: 403 },
      ),
    );

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(403);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  // ── Bad input ─────────────────────────────────────────────────────────

  it("returns 400 when the form has no file under the 'file' field", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });

    const fd = new FormData(); // no file appended

    const res = await POST(makeFormRequest(fd));
    expect(res.status).toBe(400);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  it("returns 415 when the file mime type is not in the allow-list", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const fd = new FormData();
    fd.append(
      "file",
      new File(["not an invoice"], "x.txt", { type: "text/plain" }),
    );

    const res = await POST(makeFormRequest(fd));
    expect(res.status).toBe(415);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  it("returns 400 on an empty file (size === 0)", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const fd = new FormData();
    fd.append(
      "file",
      new File([], "empty.pdf", { type: "application/pdf" }),
    );

    const res = await POST(makeFormRequest(fd));
    expect(res.status).toBe(400);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is missing (singleton throws)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));
    expect(res.status).toBe(500);
    // Route abandons the request before touching Azure.
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  // ── Upstream failures ─────────────────────────────────────────────────

  it("returns 502 when Azure OCR throws (and never reaches Anthropic)", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockRejectedValue(new Error("Azure unavailable"));

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Azure unavailable");
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("maps an Anthropic APIError to a 502 with the raw OCR text for manual fallback", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockResolvedValue(OK_OCR);
    anthropic.parse.mockRejectedValue(new anthropic.APIError("upstream 500"));

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(502);
    const body = await res.json();
    // The route promises a manual-entry fallback — rawText must come back.
    expect(body.rawText).toBe(OK_OCR.rawText);
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it("returns a structured Scan when both upstreams succeed", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockResolvedValue(OK_OCR);
    anthropic.parse.mockResolvedValue(makeParsedInvoice());

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source.distributor).toBe("Test Distributor");
    expect(body.source.invoiceNo).toBe("INV-1001");
    expect(body.items).toHaveLength(2);
    expect(body.items[0].name).toBe("Pinot Noir");
    expect(body.items[1].producer).toBe("Château Margaux");
    expect(body.quality.totalItems).toBe(2);
    // Both items are ≥0.9 confidence and we have ≥3? No — we have 2. The
    // route flags `tooFew` when totalItems < 3, so the fallback fires.
    expect(body.quality.manualFallbackTriggered).toBe(true);
    expect(body.rawText).toBe(OK_OCR.rawText);
  });

  it("returns 422 no_wines_extracted when Claude returns empty line items", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockResolvedValue(OK_OCR);
    anthropic.parse.mockResolvedValue(makeEmptyParsedInvoice());

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("no_wines_extracted");
    expect(body.message).toBeTruthy();
    expect(body.rawText).toBe(OK_OCR.rawText);
  });
});
