import { NextResponse } from "next/server";
import type { ZodIssue } from "zod";

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse<ErrorEnvelope> {
  const body: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) {
    (body.error as Record<string, unknown>).details = details;
  }
  return NextResponse.json(body, { status });
}

export const Errors = {
  unauthorized: () =>
    apiError(401, "unauthorized", "Unauthorized"),

  forbidden: (message = "Forbidden") =>
    apiError(403, "forbidden", message),

  notFound: (resource = "Resource") =>
    apiError(404, "not_found", resource + " not found."),

  badRequest: (message: string, details?: unknown, code?: string) =>
    apiError(400, code ?? "bad_request", message, details),

  validation: (issues: ZodIssue[], message = "Invalid input.") =>
    apiError(400, "validation_error", message, issues),

  conflict: (code: string, message: string) =>
    apiError(409, code, message),

  unprocessable: (code: string, message: string) =>
    apiError(422, code, message),

  tooLarge: (message = "File exceeds maximum size.") =>
    apiError(413, "too_large", message),

  unsupportedMediaType: (message: string) =>
    apiError(415, "unsupported_media_type", message),

  rateLimited: (message = "Rate limited.") =>
    apiError(429, "rate_limited", message),

  internal: (message = "Internal server error.") =>
    apiError(500, "internal_error", message),

  badGateway: (message = "Upstream service error.") =>
    apiError(502, "bad_gateway", message),
};