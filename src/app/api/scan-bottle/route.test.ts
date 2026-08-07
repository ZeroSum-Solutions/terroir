import { beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockGetAnthropicClient = vi.fn();
const mockCaptureException = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@/lib/ai/anthropic-client", () => ({
  getAnthropicClient: (...args: unknown[]) => mockGetAnthropicClient(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) =>
    mockCaptureException(...args),
}));

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

function makeSupabase(
  result: { data: Wine | null; error: unknown },
  claim: {
    outcome: string;
    response_status: number | null;
    response_body: unknown;
    response_headers: unknown;
  } = {
    outcome: "claimed",
    response_status: null,
    response_body: null,
    response_headers: null,
  },
) {
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
  const rpc = vi.fn(
    async (name: string, args: Record<string, unknown>) => {
      calls.push({ method: `rpc:${name}`, args: [args] });
      if (name === "claim_api_idempotency") {
        return { data: [claim], error: null };
      }
      if (name === "complete_api_idempotency") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  );
  return { from, rpc, calls };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

function qrRequest(
  qrPayload: unknown,
  idempotencyKey?: string,
  contentType = "application/json",
): NextRequest {
  const headers = new Headers({ "content-type": contentType });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("http://localhost/api/scan-bottle", {
    method: "POST",
    headers,
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

  it("accepts a case-insensitive JSON media type", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);

    const response = await POST(
      qrRequest(WINE_ID, undefined, "Application/JSON; Charset=UTF-8"),
    );

    expect(response.status).toBe(404);
    expect(supabase.from).toHaveBeenCalledWith("wines");
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

  it("replays a keyed QR lookup without querying the wine again", async () => {
    const replayBody = {
      id: WINE_ID,
      producer: "Stored producer",
      name: "Stored wine",
      vintage: 2020,
      varietal: null,
      region: null,
      country: null,
    };
    const supabase = makeSupabase(
      { data: null, error: null },
      {
        outcome: "replay",
        response_status: 200,
        response_body: replayBody,
        response_headers: {},
      },
    );
    allow(supabase);

    const response = await POST(
      qrRequest(WINE_ID, "bottle_lookup_replay"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(replayBody);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.calls).toContainEqual({
      method: "rpc:claim_api_idempotency",
      args: [
        expect.objectContaining({
          p_operation_id: "api:POST:/api/scan-bottle",
          p_idempotency_key: "bottle_lookup_replay",
          p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ],
    });
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

  it("binds keyed label recognition to MIME metadata and exact bytes", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const parse = vi.fn().mockResolvedValue({
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
    });
    mockGetAnthropicClient.mockReturnValue({
      messages: { parse },
    });

    async function scan(bytes: string, key: string) {
      const form = new FormData();
      form.append(
        "file",
        new File([bytes], "label.jpg", { type: "image/jpeg" }),
      );
      return POST(
        new Request("http://localhost/api/scan-bottle", {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: form,
        }) as unknown as NextRequest,
      );
    }

    expect((await scan("front", "bottle_label_front")).status).toBe(200);
    expect((await scan("back", "bottle_label_back")).status).toBe(200);

    const claims = supabase.calls
      .filter(({ method }) => method === "rpc:claim_api_idempotency")
      .map(({ args }) => args[0] as { p_request_hash: string });
    expect(claims).toHaveLength(2);
    expect(claims[0].p_request_hash).not.toBe(
      claims[1].p_request_hash,
    );
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("stores and reports an upstream provider failure without leaking it", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const upstreamError = new Anthropic.APIError(
      500,
      {},
      "secret upstream failure",
      new Headers(),
    );
    mockGetAnthropicClient.mockReturnValue({
      messages: {
        parse: vi.fn().mockRejectedValue(upstreamError),
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
        headers: { "Idempotency-Key": "provider_failure_0064" },
        body: form,
      }) as unknown as NextRequest,
    );
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(text).not.toContain("secret upstream failure");
    expect(mockCaptureException).toHaveBeenCalledWith(
      upstreamError,
      expect.objectContaining({
        tags: { surface: "scanner", phase: "claude-call" },
      }),
    );
  });

  it("classifies a provider timeout as retryable without leaking its detail", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const timeout = new Error("secret provider timeout");
    timeout.name = "TimeoutError";
    mockGetAnthropicClient.mockReturnValue({
      messages: { parse: vi.fn().mockRejectedValue(timeout) },
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["label"], "label.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        headers: { "Idempotency-Key": "provider_timeout_ter022" },
        body: form,
      }) as unknown as NextRequest,
    );
    const text = await response.text();

    expect(response.status).toBe(504);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "provider_timeout",
        message: "The AI service timed out. Please try again.",
      },
    });
    expect(text).not.toContain("secret");
    expect(mockCaptureException).toHaveBeenCalledWith(
      timeout,
      expect.objectContaining({
        extra: { failure_kind: "timeout", retryable: true },
      }),
    );
  });

  it("classifies non-400 provider input failures as non-retryable bad input", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const badInput = new Anthropic.APIError(
      413,
      {},
      "secret oversized provider payload",
      new Headers(),
    );
    mockGetAnthropicClient.mockReturnValue({
      messages: { parse: vi.fn().mockRejectedValue(badInput) },
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["label"], "label.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        headers: { "Idempotency-Key": "provider_bad_input_ter022" },
        body: form,
      }) as unknown as NextRequest,
    );
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "bad_request",
        message:
          "Could not process this photo. Try a different angle or better lighting.",
      },
    });
    expect(text).not.toContain("secret");
    expect(mockCaptureException).toHaveBeenCalledWith(
      badInput,
      expect.objectContaining({
        extra: { failure_kind: "bad_input", retryable: false },
      }),
    );
  });

  it("rejects a malformed label key before provider initialization", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);
    const form = new FormData();
    form.append(
      "file",
      new File(["label"], "label.jpg", { type: "image/jpeg" }),
    );

    const response = await POST(
      new Request("http://localhost/api/scan-bottle", {
        method: "POST",
        headers: { "Idempotency-Key": "bad key" },
        body: form,
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(mockGetAnthropicClient).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
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
