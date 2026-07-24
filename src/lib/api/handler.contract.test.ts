import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => sentry);

import { withApiHandler } from "./handler";
import { Errors } from "./errors";

describe("API handler contract", () => {
  beforeEach(() => {
    sentry.captureException.mockReset();
  });

  it("passes successful, redirect, and existing error responses through unchanged", async () => {
    const success = NextResponse.json(
      { ok: true },
      { status: 201, headers: { "X-Result": "created" } },
    );
    const redirect = NextResponse.redirect("http://localhost/login", 303);
    const existingError = Errors.notFound("Wine");

    await expect(withApiHandler(() => success)).resolves.toBe(success);
    await expect(withApiHandler(() => redirect)).resolves.toBe(redirect);
    await expect(withApiHandler(() => existingError)).resolves.toBe(existingError);
  });

  it("captures thrown errors but returns only a redacted envelope", async () => {
    const original = new Error("postgres password=secret");
    const response = await withApiHandler(async () => {
      throw original;
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("postgres");
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException).toHaveBeenCalledWith(original);
  });

  it("redacts non-Error throws", async () => {
    const response = await withApiHandler(() => {
      throw "database-secret";
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("database-secret");
    expect(sentry.captureException).toHaveBeenCalledWith("database-secret");
  });

  it("still returns the generic envelope if error reporting fails", async () => {
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error("sentry unavailable");
    });

    const response = await withApiHandler(() => {
      throw new Error("primary failure");
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });
});
