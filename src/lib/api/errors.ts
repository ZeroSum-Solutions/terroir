import { NextResponse } from "next/server";
import type { ZodIssue } from "zod";

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiErrorInit = Omit<ResponseInit, "status">;

export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  init?: ApiErrorInit,
): NextResponse<ErrorEnvelope> {
  const body: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) {
    (body.error as Record<string, unknown>).details = details;
  }
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return NextResponse.json(body, { ...init, headers, status });
}

export const Errors = {
  unauthorized: (init?: ApiErrorInit) =>
    apiError(401, "unauthorized", "Unauthorized", undefined, init),

  forbidden: (message = "Forbidden", init?: ApiErrorInit) =>
    apiError(403, "forbidden", message, undefined, init),

  notFound: (resource = "Resource", init?: ApiErrorInit) =>
    apiError(404, "not_found", resource + " not found.", undefined, init),

  badRequest: (
    message: string,
    details?: unknown,
    code?: string,
    init?: ApiErrorInit,
  ) => apiError(400, code ?? "bad_request", message, details, init),

  validation: (
    issues: ZodIssue[],
    message = "Invalid input.",
    init?: ApiErrorInit,
  ) => apiError(400, "validation_error", message, issues, init),

  conflict: (code: string, message: string, init?: ApiErrorInit) =>
    apiError(409, code, message, undefined, init),

  unprocessable: (code: string, message: string, init?: ApiErrorInit) =>
    apiError(422, code, message, undefined, init),

  tooLarge: (
    message = "File exceeds maximum size.",
    init?: ApiErrorInit,
  ) => apiError(413, "too_large", message, undefined, init),

  unsupportedMediaType: (message: string, init?: ApiErrorInit) =>
    apiError(415, "unsupported_media_type", message, undefined, init),

  rateLimited: (message = "Rate limited.", init?: ApiErrorInit) =>
    apiError(429, "rate_limited", message, undefined, init),

  internal: (message = "Internal server error.", init?: ApiErrorInit) =>
    apiError(500, "internal_error", message, undefined, init),

  badGateway: (message = "Upstream service error.", init?: ApiErrorInit) =>
    apiError(502, "bad_gateway", message, undefined, init),

  invalidJson: (init?: ApiErrorInit) =>
    apiError(400, "invalid_json", "Invalid JSON.", undefined, init),

  invalidFormData: (init?: ApiErrorInit) =>
    apiError(400, "invalid_form_data", "Invalid form data.", undefined, init),
};
