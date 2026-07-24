import { describe, expect, it } from "vitest";
import { apiResultResponse } from "./result-response";

describe("apiResultResponse", () => {
  it("preserves successful bodies and statuses", async () => {
    const response = apiResultResponse({
      status: 201,
      body: { id: "created" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "created" });
  });

  it("preserves explicit idempotency and retry headers", () => {
    const response = apiResultResponse({
      status: 409,
      body: {
        error: {
          code: "idempotency_in_progress",
          message: "Still in progress.",
        },
      },
      headers: {
        "Idempotency-Replayed": "false",
        "Retry-After": "1",
      },
    });

    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("normalizes legacy validation failures", async () => {
    const response = apiResultResponse({
      status: 409,
      body: { error: "A request is already in progress." },
    });

    expect(await response.json()).toEqual({
      error: {
        code: "conflict",
        message: "A request is already in progress.",
      },
    });
  });

  it("redacts server failures while preserving manual fallback data", async () => {
    const response = apiResultResponse({
      status: 502,
      body: {
        code: "upstream_error",
        message: "super-secret provider failure",
        rawText: "readable invoice text",
      },
    });
    const text = await response.text();

    expect(JSON.parse(text)).toEqual({
      error: {
        code: "bad_gateway",
        message: "Upstream service error.",
        details: { rawText: "readable invoice text" },
      },
    });
    expect(text).not.toContain("super-secret");
  });

  it("places domain fallback data under error details", async () => {
    const response = apiResultResponse({
      status: 422,
      body: {
        code: "no_wines_extracted",
        message: "No wines were found.",
        scanId: "scan-a",
        rawText: "invoice text",
      },
    });

    expect(await response.json()).toEqual({
      error: {
        code: "no_wines_extracted",
        message: "No wines were found.",
        details: { scanId: "scan-a", rawText: "invoice text" },
      },
    });
  });
});
