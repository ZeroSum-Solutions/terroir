import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockGetAnthropicClient = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: (...args: unknown[]) => mockGetAnthropicClient(...args),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");

const WINE_ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
type Wine = {
  id: string;
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
  restaurant_id: string;
};

function makeSupabase(result: { data: Wine | null; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const from = vi.fn(() => ({
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return {
        eq: (...eqArgs: unknown[]) => {
          calls.push({ method: "eq", args: eqArgs });
          return { maybeSingle: async () => result };
        },
      };
    },
  }));
  return { from, calls };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

function qrRequest(qrPayload: unknown): NextRequest {
  return new Request("http://localhost/api/scan-bottle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ qr_payload: qrPayload }),
  }) as unknown as NextRequest;
}

describe("POST /api/scan-bottle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed QR payload before database access", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);

    const response = await POST(qrRequest("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["qr_payload"] }],
      },
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("returns wine_not_found for a missing QR wine", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);

    const response = await POST(qrRequest(WINE_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "wine_not_found",
        message: "No wine found for that QR code. It may have been deleted.",
      },
    });
  });

  it("redacts a QR lookup provider failure", async () => {
    const supabase = makeSupabase({
      data: null,
      error: { code: "XX000", message: "super-secret query failure" },
    });
    allow(supabase);

    const response = await POST(qrRequest(WINE_ID));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(text).not.toContain("super-secret");
  });

  it("preserves the known-foreign QR response", async () => {
    const supabase = makeSupabase({
      data: {
        id: WINE_ID,
        producer: "Foreign producer",
        name: "Foreign wine",
        vintage: 2020,
        varietal: null,
        region: null,
        country: null,
        restaurant_id: "restaurant-b",
      },
      error: null,
    });
    allow(supabase);

    const response = await POST(qrRequest(WINE_ID));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "cross_tenant_qr",
        message: "This QR code belongs to a different restaurant.",
      },
    });
  });

  it("returns an owned wine without leaking restaurant_id", async () => {
    const supabase = makeSupabase({
      data: {
        id: WINE_ID,
        producer: "Producer",
        name: "Wine",
        vintage: 2021,
        varietal: "Pinot Noir",
        region: "Willamette Valley",
        country: "USA",
        restaurant_id: "restaurant-a",
      },
      error: null,
    });
    allow(supabase);

    const response = await POST(qrRequest(WINE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ id: WINE_ID, name: "Wine" });
    expect(body).not.toHaveProperty("restaurant_id");
  });

  it("preserves bottle-label photo success", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    mockGetAnthropicClient.mockReturnValue({
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            candidates: [
              {
                name: "Volnay",
                producer: "Domaine Test",
                vintage: 2022,
                varietal: "Pinot Noir",
                region: "Burgundy",
                country: "France",
                format: "750ml",
                confidence: 0.98,
                lowFields: [],
                notes: null,
              },
            ],
          },
        }),
      },
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["label"], "label.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        body: form,
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidates: [
        expect.objectContaining({
          name: "Volnay",
          producer: "Domaine Test",
          confidence: 0.98,
        }),
      ],
    });
  });

  it("passes through multiple ranked candidates with per-field low-confidence flags", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    mockGetAnthropicClient.mockReturnValue({
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            candidates: [
              {
                name: "Volnay 1er Cru",
                producer: "Domaine Test",
                vintage: 2019,
                varietal: "Pinot Noir",
                region: "Burgundy",
                country: "France",
                format: null,
                confidence: 0.62,
                lowFields: ["vintage", "format"],
                notes: "Vintage partially obscured by a torn label.",
              },
              {
                name: "Volnay Villages",
                producer: "Domaine Test",
                vintage: 2017,
                varietal: "Pinot Noir",
                region: "Burgundy",
                country: "France",
                format: null,
                confidence: 0.41,
                lowFields: ["name", "vintage"],
                notes: null,
              },
            ],
          },
        }),
      },
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["label"], "label.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        body: form,
      }) as unknown as NextRequest,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0]).toMatchObject({
      name: "Volnay 1er Cru",
      confidence: 0.62,
      lowFields: ["vintage", "format"],
    });
    expect(body.candidates[1]).toMatchObject({
      name: "Volnay Villages",
      confidence: 0.41,
      lowFields: ["name", "vintage"],
    });
  });

  it("returns parse_failed when the model returns no candidates", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    mockGetAnthropicClient.mockReturnValue({
      messages: {
        parse: vi.fn().mockResolvedValue({ parsed_output: null }),
      },
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["label"], "label.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        body: form,
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "parse_failed" },
    });
  });

  it("rejects unsupported label files before client initialization", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const form = new FormData();
    form.append("file", new File(["x"], "label.txt", { type: "text/plain" }));

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        body: form,
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_media_type" },
    });
    expect(mockGetAnthropicClient).not.toHaveBeenCalled();
  });

  it("rejects multiple bottle-label files before client initialization", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const form = new FormData();
    form.append(
      "file",
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
    );
    form.append(
      "file",
      new File(["back"], "back.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        body: form,
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["file"] }],
      },
    });
    expect(mockGetAnthropicClient).not.toHaveBeenCalled();
  });
});
