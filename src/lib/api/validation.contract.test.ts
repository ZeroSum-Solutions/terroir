// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  fileField,
  parseJson,
  parseMultipart,
  parseParams,
  parseQuery,
  type ParseResult,
} from "./validation";

async function errorFrom<T>(result: ParseResult<T>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected parsing to fail.");
  return {
    response: result.response,
    body: await result.response.json(),
  };
}

describe("API validation contract", () => {
  it("returns transformed JSON output", async () => {
    const request = new Request("http://localhost/api/example", {
      method: "POST",
      body: JSON.stringify({ quantity: "3" }),
    });
    const result = await parseJson(
      request,
      z.strictObject({ quantity: z.coerce.number().int().positive() }),
    );

    expect(result).toEqual({ ok: true, data: { quantity: 3 } });
  });

  it("distinguishes malformed JSON from schema-invalid JSON", async () => {
    const schemaCheck = vi.fn();
    const schema = z
      .strictObject({ quantity: z.number().int().positive() })
      .superRefine(schemaCheck);
    const malformed = await parseJson(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: "{",
      }),
      schema,
    );
    const malformedError = await errorFrom(malformed);

    expect(malformedError.response.status).toBe(400);
    expect(malformedError.body).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
    expect(schemaCheck).not.toHaveBeenCalled();

    const invalid = await parseJson(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: JSON.stringify({ quantity: 0 }),
      }),
      schema,
    );
    const invalidError = await errorFrom(invalid);

    expect(invalidError.response.status).toBe(400);
    expect(invalidError.body).toMatchObject({
      error: {
        code: "validation_error",
        message: "Invalid input.",
        details: [{ path: ["quantity"] }],
      },
    });
  });

  it("passes empty and whitespace-only JSON as undefined only when allowed", async () => {
    const rejected = await parseJson(
      new Request("http://localhost/api/example", { method: "POST" }),
      z.object({ slug: z.string().optional() }),
    );
    expect((await errorFrom(rejected)).body).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });

    const accepted = await parseJson(
      new Request("http://localhost/api/example", { method: "POST" }),
      z.object({ slug: z.string().optional() }).default({}),
      { allowEmpty: true },
    );
    expect(accepted).toEqual({ ok: true, data: {} });

    const whitespace = await parseJson(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: " \n\t ",
      }),
      z.undefined(),
      { allowEmpty: true },
    );
    expect(whitespace).toEqual({ ok: true, data: undefined });

    const malformed = await parseJson(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: "{",
      }),
      z.object({}).default({}),
      { allowEmpty: true },
    );
    expect((await errorFrom(malformed)).body).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
  });

  it("coerces query values while preserving duplicate keys as arrays", async () => {
    const parsed = await parseQuery(
      new URLSearchParams("limit=5"),
      z.strictObject({ limit: z.coerce.number().int().positive() }),
    );
    expect(parsed).toEqual({ ok: true, data: { limit: 5 } });

    const duplicateScalar = await parseQuery(
      new URLSearchParams("limit=5&limit=6"),
      z.strictObject({ limit: z.coerce.number().int().positive() }),
    );
    expect((await errorFrom(duplicateScalar)).body).toMatchObject({
      error: { code: "validation_error" },
    });

    const repeated = await parseQuery(
      new URLSearchParams("tag=red&tag=white"),
      z.strictObject({ tag: z.array(z.string()) }),
    );
    expect(repeated).toEqual({
      ok: true,
      data: { tag: ["red", "white"] },
    });
  });

  it("parses promised route params and rejects malformed UUIDs", async () => {
    const schema = z.strictObject({ id: z.string().uuid() });
    const validId = "34d653d0-2755-4e5d-9fd2-b16de744fc28";

    await expect(parseParams(Promise.resolve({ id: validId }), schema)).resolves
      .toEqual({ ok: true, data: { id: validId } });

    const invalid = await parseParams(Promise.resolve({ id: "nope" }), schema);
    expect((await errorFrom(invalid)).body).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["id"] }],
      },
    });
  });

  it("supports asynchronous Zod refinements and transforms", async () => {
    const result = await parseParams(
      { id: "wine-123" },
      z.object({
        id: z.string().refine(async (value) => value.startsWith("wine-"))
          .transform(async (value) => value.toUpperCase()),
      }),
    );

    expect(result).toEqual({ ok: true, data: { id: "WINE-123" } });
  });

  it("parses multipart strings and actual File fields", async () => {
    const form = new FormData();
    const file = new File(["label"], "label.jpg", { type: "image/jpeg" });
    form.append("note", "front label");
    form.append("file", file);

    const parsed = await parseMultipart(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: form,
      }),
      z.strictObject({ note: z.string(), file: fileField }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.note).toBe("front label");
    expect(parsed.data.file).toBeInstanceOf(File);
    expect(parsed.data.file.name).toBe("label.jpg");
  });

  it("preserves repeated multipart fields and rejects non-files", async () => {
    const form = new FormData();
    form.append("tag", "red");
    form.append("tag", "white");
    form.append("file", "not-a-file");

    const repeated = await parseMultipart(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: form,
      }),
      z.strictObject({
        tag: z.array(z.string()),
        file: fileField,
      }),
    );
    const error = await errorFrom(repeated);

    expect(error.body).toMatchObject({
      error: {
        code: "validation_error",
        details: [{ path: ["file"] }],
      },
    });
  });

  it("presents multipart fields to schemas in a null-prototype record", async () => {
    const form = new FormData();
    form.append("note", "front label");
    let prototype: object | null | undefined;
    const schema = z.custom<Record<string, unknown>>((value) => {
      prototype = Object.getPrototypeOf(value);
      return true;
    });

    const result = await parseMultipart(
      new Request("http://localhost/api/example", {
        method: "POST",
        body: form,
      }),
      schema,
    );

    expect(result.ok).toBe(true);
    expect(prototype).toBeNull();
  });

  it("returns invalid_form_data when multipart decoding fails", async () => {
    const result = await parseMultipart(
      new Request("http://localhost/api/example", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data" },
        body: "missing-boundary",
      }),
      z.object({}),
    );

    expect((await errorFrom(result)).body).toEqual({
      error: {
        code: "invalid_form_data",
        message: "Invalid form data.",
      },
    });
  });
});
