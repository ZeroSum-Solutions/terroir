import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockRateLimit = vi.fn();
const mockAssertInvoiceExtractionConfigured = vi.fn();
const mockProcessInvoiceScanOnce = vi.fn();
const mockWithIdempotency = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@/lib/api/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
vi.mock("@/adapters/llm/anthropic-invoice-extraction", () => ({
  assertInvoiceExtractionConfigured: (...args: unknown[]) =>
    mockAssertInvoiceExtractionConfigured(...args),
}));
vi.mock("@/domains/scanning/invoice-scan-service", () => ({
  processInvoiceScanOnce: (...args: unknown[]) =>
    mockProcessInvoiceScanOnce(...args),
}));
vi.mock("@/lib/api/idempotency", () => ({
  isValidIdempotencyKey: () => false,
  withIdempotency: (...args: unknown[]) => mockWithIdempotency(...args),
}));
vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: scanInvoice } = await import("./scan/route");
const { POST: scanBottle } = await import("./scan-bottle/route");
const { POST: confirmBottle } = await import("./scan-bottle/confirm/route");
const { POST: saveInvoiceScan } = await import("./inventory/save-scan/route");
const { POST: saveBottleScan } = await import(
  "./inventory/save-bottle-scan/route"
);

function jsonRequest(path: string, body: string): NextRequest {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }) as unknown as NextRequest;
}

const operations = [
  {
    name: "invoice scan",
    invoke: (body: string) => scanInvoice(jsonRequest("/api/scan", body)),
  },
  {
    name: "bottle scan",
    invoke: (body: string) =>
      scanBottle(jsonRequest("/api/scan-bottle", body)),
  },
  {
    name: "bottle confirmation",
    invoke: (body: string) =>
      confirmBottle(jsonRequest("/api/scan-bottle/confirm", body)),
  },
  {
    name: "invoice inventory save",
    invoke: (body: string) =>
      saveInvoiceScan(jsonRequest("/api/inventory/save-scan", body)),
  },
  {
    name: "bottle inventory save",
    invoke: (body: string) =>
      saveBottleScan(jsonRequest("/api/inventory/save-bottle-scan", body)),
  },
] as const;

describe("scan ingestion API boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockReturnValue({ ok: true });
    mockWithIdempotency.mockImplementation(
      async (options: {
        handler: () => Promise<{ status: number; body: unknown }>;
      }) => ({ ...(await options.handler()), replayed: false }),
    );
  });

  it.each(operations)(
    "redacts unexpected authentication failures for $name",
    async ({ invoke }) => {
      mockRequireMembership.mockRejectedValue(
        new Error("super-secret auth failure"),
      );

      const response = await invoke("{");
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "internal_error",
          message: "Internal server error.",
        },
      });
      expect(text).not.toContain("super-secret");
    },
  );

  it.each(operations)(
    "preserves authentication denial identity before reading $name input",
    async ({ invoke }) => {
      const denial = NextResponse.json(
        { error: { code: "denied", message: "No." } },
        { status: 403, headers: { "x-auth-denial": "exact" } },
      );
      mockRequireMembership.mockResolvedValue(denial);

      const response = await invoke("{");

      expect(response).toBe(denial);
      expect(response.headers.get("x-auth-denial")).toBe("exact");
      expect(mockAssertInvoiceExtractionConfigured).not.toHaveBeenCalled();
      expect(mockWithIdempotency).not.toHaveBeenCalled();
    },
  );

  it.each(operations)(
    "returns the shared malformed-JSON envelope for $name",
    async ({ invoke }) => {
      mockRequireMembership.mockResolvedValue({
        supabase: {},
        user: { id: "user-a" },
        restaurantId: "restaurant-a",
        role: "owner",
      });

      const response = await invoke("{");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_json", message: "Invalid JSON." },
      });
    },
  );

  it.each(operations)(
    "returns validation details for schema-invalid $name input",
    async ({ invoke }) => {
      mockRequireMembership.mockResolvedValue({
        supabase: {},
        user: { id: "user-a" },
        restaurantId: "restaurant-a",
        role: "owner",
      });

      const response = await invoke("{}");
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: {
          code: "validation_error",
          message: "Invalid body.",
          details: expect.any(Array),
        },
      });
    },
  );

  it("performs no JSON-path provider or database work for an idempotency replay", async () => {
    const download = vi.fn().mockResolvedValue({
      data: new Blob(["invoice"]),
      error: null,
    });
    const from = vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: { id: "new-orphan" },
            error: null,
          }),
        })),
      })),
    }));
    mockRequireMembership.mockResolvedValue({
      supabase: {
        storage: { from: vi.fn(() => ({ download })) },
        from,
      },
      user: { id: "user-a" },
      restaurantId: "restaurant-a",
      role: "owner",
    });
    mockWithIdempotency.mockResolvedValue({
      status: 200,
      body: { scanId: "cached-scan" },
      replayed: true,
    });

    const response = await scanInvoice(
      jsonRequest(
        "/api/scan",
        JSON.stringify({
          imagePath: "restaurant-a/cached-scan/invoice.jpg",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scanId: "cached-scan" });
    expect(download).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(mockAssertInvoiceExtractionConfigured).not.toHaveBeenCalled();
  });

  it("rejects foreign JSON storage paths before provider access", async () => {
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: { statusCode: "404" },
    });
    mockRequireMembership.mockResolvedValue({
      supabase: {
        storage: { from: vi.fn(() => ({ download })) },
      },
      user: { id: "user-a" },
      restaurantId: "restaurant-a",
      role: "owner",
    });

    const response = await scanInvoice(
      jsonRequest(
        "/api/scan",
        JSON.stringify({
          imagePath: "restaurant-b/scan-a/invoice.jpg",
        }),
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Image not found." },
    });
    expect(download).not.toHaveBeenCalled();
    expect(mockAssertInvoiceExtractionConfigured).not.toHaveBeenCalled();
    expect(mockWithIdempotency).not.toHaveBeenCalled();
  });
});
