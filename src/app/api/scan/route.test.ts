import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
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

const rateLimitMock = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/api/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock.rateLimit(...args),
}));

// Grok-2: processInvoiceScanOnce's persist write now chains
// .eq().eq().select("id") and reads back `data` to detect whether its
// fence on status='processing' matched. Making the shared mockReturnThis()
// object itself thenable — resolving with a non-empty row, `error: null`
// — keeps every existing .eq()-only chain in this file resolving exactly
// as before while satisfying the new fencing check.
function makeSupabase() { return { from: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: "scan-1" }, error: null }), update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), storage: { from: vi.fn().mockReturnThis(), download: vi.fn().mockRejectedValue(new Error("not found")), upload: vi.fn().mockResolvedValue({ error: null }) }, rpc: vi.fn(), catch: vi.fn().mockReturnThis(), then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve({ data: [{ id: "scan-1" }], error: null }).then(resolve, reject) }; }

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
  }) as unknown as NextRequest;
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
    process.env.OPENROUTER_API_KEY = "sk-test";
    rateLimitMock.rateLimit.mockReturnValue({ ok: true });
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
    const body415 = await res.json();
    expect(body415.error.code).toBe("unsupported_media_type");
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  it("returns 415 when JSON body path has an unsupported file extension", async () => {
    const s = makeSupabase();
    s.storage.from("invoice-images").download = vi.fn().mockResolvedValue({
      data: new Blob(["GIF89a stub"]),
      error: null,
    });

    auth.requireMembership.mockResolvedValue({
      supabase: s,
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });

    const rq = new Request("http://localhost/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imagePath: "restaurant-A/scan-1/image.gif" }),
    }) as unknown as NextRequest;

    const rs = await POST(rq);
    expect(rs.status).toBe(415);
    const bd = await rs.json();
    expect(bd.error.code).toBe("unsupported_media_type");
    expect(s.storage.from("invoice-images").download).not.toHaveBeenCalled();
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("returns a fixed 404 for a missing stored image", async () => {
    const s = makeSupabase();
    s.storage.from("invoice-images").download = vi.fn().mockResolvedValue({
      data: null,
      error: {
        statusCode: "404",
        message: "super-secret storage object details",
      },
    });
    auth.requireMembership.mockResolvedValue({
      supabase: s,
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });

    const res = await POST(
      new Request("http://localhost/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imagePath: "restaurant-A/scan-1/image.jpg",
        }),
      }) as unknown as NextRequest,
    );
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({
      error: { code: "not_found", message: "Image not found." },
    });
    expect(text).not.toContain("super-secret");
  });

  it("redacts a stored-image provider failure", async () => {
    const s = makeSupabase();
    s.storage.from("invoice-images").download = vi.fn().mockResolvedValue({
      data: null,
      error: {
        statusCode: "500",
        message: "super-secret storage outage",
      },
    });
    auth.requireMembership.mockResolvedValue({
      supabase: s,
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });

    const res = await POST(
      new Request("http://localhost/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imagePath: "restaurant-A/scan-1/image.jpg",
        }),
      }) as unknown as NextRequest,
    );
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(text).not.toContain("super-secret");
  });

  it("returns 413 when the file exceeds 10 MB", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });

    // Create a Buffer whose byte length is > 10 MB so File.size reflects reality
    const buf = Buffer.alloc(11 * 1024 * 1024, 65); // 11 MB of "A"
    const bigFile = new File([buf], "big.jpg", { type: "image/jpeg" });
    const fd = new FormData();
    fd.append("file", bigFile);

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.message).toContain("10 MB");
    // Azure DI must not be called for oversized uploads
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

  it("returns 500 when OPENROUTER_API_KEY is missing (singleton throws)", async () => {
    delete process.env.OPENROUTER_API_KEY;
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
    expect(await res.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    // Route abandons the request before touching Azure.
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
  });

  // ── Upstream failures ─────────────────────────────────────────────────

  it("Azure OCR throws: extracts from the image instead and succeeds (vision fallback)", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockRejectedValue(new Error("Azure unavailable"));
    anthropic.parse.mockResolvedValue(makeParsedInvoice());

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(200);
    // The model was handed the document itself, not OCR text.
    const content = anthropic.parse.mock.calls[0][0].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("document");
    const body = await res.json();
    expect(body.rawText).toBe("");
    expect(JSON.stringify(body)).not.toContain("Azure unavailable");
  });

  it("returns 502 when Azure OCR throws and the vision fallback is switched off", async () => {
    process.env.INVOICE_VISION_FALLBACK = "off";
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
    delete process.env.INVOICE_VISION_FALLBACK;

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "bad_gateway", message: "Upstream service error." },
    });
    expect(JSON.stringify(body)).not.toContain("Azure unavailable");
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
    expect(body.error.details.rawText).toBe(OK_OCR.rawText);
    expect(body.error.message).toBe("Upstream service error.");
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

  it("preserves repeated multipart files for multi-page invoices", async () => {
    const supabase = makeSupabase();
    auth.requireMembership.mockResolvedValue({
      supabase,
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockResolvedValue(OK_OCR);
    anthropic.parse.mockResolvedValue(makeParsedInvoice());
    const fd = new FormData();
    fd.append(
      "file",
      new File(["page one"], "page-1.jpg", { type: "image/jpeg" }),
    );
    fd.append(
      "file",
      new File(["page two"], "page-2.png", { type: "image/png" }),
    );

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(200);
    expect(supabase.storage.upload).toHaveBeenCalledTimes(2);
  });

  it("OCRs every page of a multi-page invoice and merges them into one Claude prompt (BND-081 / TER-CF-032)", async () => {
    const supabase = makeSupabase();
    auth.requireMembership.mockResolvedValue({
      supabase,
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockImplementation(async (buf: Buffer) =>
      buf.toString().includes("page one")
        ? { ...OK_OCR, rawText: "UNIQUE_PAGE_ONE_TEXT" }
        : { ...OK_OCR, rawText: "UNIQUE_PAGE_TWO_TEXT" },
    );
    anthropic.parse.mockResolvedValue(makeParsedInvoice());
    const fd = new FormData();
    fd.append("file", new File(["page one"], "page-1.jpg", { type: "image/jpeg" }));
    fd.append("file", new File(["page two"], "page-2.png", { type: "image/png" }));

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(200);
    expect(azure.analyzeInvoice).toHaveBeenCalledTimes(2);
    const promptText = JSON.stringify(anthropic.parse.mock.calls[0][0]);
    expect(promptText).toContain("UNIQUE_PAGE_ONE_TEXT");
    expect(promptText).toContain("UNIQUE_PAGE_TWO_TEXT");
  });

  it("rejects more than the page cap immediately, before any Azure/Anthropic work", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const fd = new FormData();
    for (let i = 0; i < 9; i++) {
      fd.append("file", new File([`page ${i}`], `page-${i}.jpg`, { type: "image/jpeg" }));
    }

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/8 pages/i);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("rejects a batch with more than one PDF, before any Azure/Anthropic work (BND-AF01)", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const fd = new FormData();
    fd.append("file", new File(["invoice one"], "invoice-1.pdf", { type: "application/pdf" }));
    fd.append("file", new File(["invoice two"], "invoice-2.pdf", { type: "application/pdf" }));
    fd.append("file", new File(["invoice three"], "invoice-3.pdf", { type: "application/pdf" }));

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("mixed_pdf_batch");
    expect(body.error.message).toMatch(/one PDF per invoice/i);
    expect(body.error.message).toContain("3 PDFs");
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("rejects a single PDF mixed with an image page (BND-AF01 round 2 — a PDF may never be combined with anything else)", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    const fd = new FormData();
    fd.append("file", pdfFile());
    fd.append("file", new File(["page two"], "page-2.jpg", { type: "image/jpeg" }));

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("mixed_pdf_batch");
    expect(body.error.message).toMatch(/complete invoice on its own/i);
    expect(azure.analyzeInvoice).not.toHaveBeenCalled();
    expect(anthropic.parse).not.toHaveBeenCalled();
  });

  it("stores HEIC pages with their real extension", async () => {
    const supabase = makeSupabase();
    auth.requireMembership.mockResolvedValue({
      supabase,
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    azure.analyzeInvoice.mockResolvedValue(OK_OCR);
    anthropic.parse.mockResolvedValue(makeParsedInvoice());
    const fd = new FormData();
    fd.append(
      "file",
      new File(["heic"], "invoice.heic", { type: "image/heic" }),
    );

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(200);
    expect(supabase.storage.upload).toHaveBeenCalledWith(
      expect.stringMatching(/\.heic$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/heic" }),
    );
  });

  it("keeps a successful scan successful when best-effort upload rejects", async () => {
    const supabase = makeSupabase();
    supabase.storage.upload.mockRejectedValue(
      new Error("super-secret storage outage"),
    );
    auth.requireMembership.mockResolvedValue({
      supabase,
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
    expect(await res.json()).toMatchObject({
      scanId: "scan-1",
      items: expect.any(Array),
    });
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
    expect(body.error.code).toBe("no_wines_extracted");
    expect(body.error.message).toBeTruthy();
    expect(body.error.details.rawText).toBe(OK_OCR.rawText);
  });
  // ── Rate limiting ──────────────────────────────────────────────────────

  it("returns 429 when the per-minute scan rate limit is exceeded", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    rateLimitMock.rateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 30 });

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "rate_limited",
        message:
          "Too many scan requests. Please wait before scanning again.",
      },
    });
  });

  it("returns a Retry-After header when returning 429", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    rateLimitMock.rateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 42 });

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  it("proceeds normally when rate limit is not exceeded", async () => {
    auth.requireMembership.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: "u1" },
      restaurantId: "restaurant-A",
      role: "owner",
    });
    rateLimitMock.rateLimit.mockReturnValue({ ok: true });
    azure.analyzeInvoice.mockResolvedValue(OK_OCR);
    anthropic.parse.mockResolvedValue(makeParsedInvoice());

    const fd = new FormData();
    fd.append("file", pdfFile());

    const res = await POST(makeFormRequest(fd));

    expect(res.status).toBe(200);
  });

});
