import type { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import { Errors, type ErrorEnvelope } from "./errors";

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<ErrorEnvelope> };

export interface ParseOptions {
  message?: string;
}

export interface ParseJsonOptions extends ParseOptions {
  allowEmpty?: boolean;
}

export const fileField = z.custom<File>(
  (value) => typeof File !== "undefined" && value instanceof File,
  { message: "Expected a file." },
);

function collectEntries<T>(
  entries: Iterable<[string, T]>,
): Record<string, T | T[]> {
  const values = Object.create(null) as Record<string, T | T[]>;
  for (const [key, value] of entries) {
    const current = values[key];
    if (current === undefined) values[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else values[key] = [current, value];
  }
  return values;
}

async function validate<S extends ZodType>(
  value: unknown,
  schema: S,
  options?: ParseOptions,
): Promise<ParseResult<z.output<S>>> {
  const parsed = await schema.safeParseAsync(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    response: Errors.validation(
      parsed.error.issues,
      options?.message ?? "Invalid input.",
    ),
  };
}

export async function parseJson<S extends ZodType>(
  request: Request,
  schema: S,
  options?: ParseJsonOptions,
): Promise<ParseResult<z.output<S>>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: Errors.invalidJson() };
  }
  if (text.trim() === "") {
    if (!options?.allowEmpty) {
      return { ok: false, response: Errors.invalidJson() };
    }
    return validate(undefined, schema, options);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: Errors.invalidJson() };
  }
  return validate(value, schema, options);
}

export function parseQuery<S extends ZodType>(
  params: URLSearchParams,
  schema: S,
  options?: ParseOptions,
): Promise<ParseResult<z.output<S>>> {
  return validate(collectEntries(params.entries()), schema, options);
}

export async function parseParams<S extends ZodType>(
  params: unknown | PromiseLike<unknown>,
  schema: S,
  options?: ParseOptions,
): Promise<ParseResult<z.output<S>>> {
  return validate(await params, schema, options);
}

export async function parseMultipart<S extends ZodType>(
  request: Request,
  schema: S,
  options?: ParseOptions,
): Promise<ParseResult<z.output<S>>> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, response: Errors.invalidFormData() };
  }
  return validate(collectEntries(formData.entries()), schema, options);
}
