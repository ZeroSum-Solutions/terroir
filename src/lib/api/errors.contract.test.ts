import { describe, expect, it } from "vitest";
import { apiError, Errors } from "./errors";

describe("API error envelope contract", () => {
  it("wraps custom errors in a stable nested envelope", async () => {
    const response = apiError(409, "slug_collision", "Slug already exists.", {
      field: "slug",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "slug_collision",
        message: "Slug already exists.",
        details: { field: "slug" },
      },
    });
  });

  it("keeps helper errors on the same nested envelope shape", async () => {
    const helpers = [
      Errors.unauthorized,
      () => Errors.forbidden("Nope."),
      () => Errors.notFound("Wine list"),
      () => Errors.badRequest("Bad request."),
      () => Errors.conflict("no_inventory", "No inventory available."),
      () => Errors.internal("Internal."),
    ];

    for (const buildResponse of helpers) {
      const body = await buildResponse().json();
      expect(body).toEqual({
        error: {
          code: expect.any(String),
          message: expect.any(String),
        },
      });
    }
  });

  it("preserves response metadata without allowing the error status to change", async () => {
    const headers = new Headers({
      "Content-Length": "999",
      "Content-Type": "text/html",
      "Retry-After": "17",
      "X-Correlation-ID": "request-123",
    });
    const response = apiError(
      429,
      "rate_limited",
      "Slow down.",
      undefined,
      {
        headers,
        status: 201,
        statusText: "Too Many Requests",
      } as never,
    );

    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("x-correlation-id")).toBe("request-123");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "Slow down.",
      },
    });
  });

  it("keeps Retry-After on rate-limit helper responses", async () => {
    const response = Errors.rateLimited("Try again later.", {
      headers: { "Retry-After": "42" },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "Try again later.",
      },
    });
  });

  it("provides fixed parser failure envelopes", async () => {
    const invalidJson = Errors.invalidJson();
    const invalidFormData = Errors.invalidFormData();

    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
    expect(invalidFormData.status).toBe(400);
    await expect(invalidFormData.json()).resolves.toEqual({
      error: { code: "invalid_form_data", message: "Invalid form data." },
    });
  });
});
