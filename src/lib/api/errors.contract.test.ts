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
});

