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
  const query = {
    eq: (...eqArgs: unknown[]) => {
      calls.push({ method: "eq", args: eqArgs });
      return query;
    },
    maybeSingle: async () => result,
  };
  const from = vi.fn(() => ({
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return query;
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

  it("returns an opaque not-found response for a missing QR wine", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);

    const response = await POST(qrRequest(WINE_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Wine not found.",
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

  it("returns the same opaque response for a known foreign QR wine", async () => {
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

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "Wine not found.",
      },
    });
    expect(supabase.calls).toContainEqual({
      method: "eq",
      args: ["restaurant_id", "restaurant-a"],
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
            name: "Volnay",
            producer: "Domaine Test",
            vintage: 2022,
            varietal: "Pinot Noir",
            region: "Burgundy",
            country: "France",
            confidence: 0.98,
            notes: null,
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
      name: "Volnay",
      producer: "Domaine Test",
      confidence: 0.98,
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
