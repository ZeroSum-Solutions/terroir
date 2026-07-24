import { NextResponse } from "next/server";
import { apiError, type ErrorEnvelope } from "./errors";

type ApiResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

const STATUS_DEFAULTS: Record<number, { code: string; message: string }> = {
  400: { code: "bad_request", message: "Bad request." },
  404: { code: "not_found", message: "Resource not found." },
  409: { code: "conflict", message: "Request conflict." },
  413: { code: "too_large", message: "File exceeds maximum size." },
  415: {
    code: "unsupported_media_type",
    message: "Unsupported media type.",
  },
  422: { code: "unprocessable", message: "Unable to process request." },
  429: { code: "rate_limited", message: "Rate limited." },
  500: { code: "internal_error", message: "Internal server error." },
  502: { code: "bad_gateway", message: "Upstream service error." },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  const outer = record(value);
  const error = record(outer?.error);
  return typeof error?.code === "string" && typeof error.message === "string";
}

export function apiResultResponse(result: ApiResult): NextResponse {
  if (result.status < 400) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }
  if (isErrorEnvelope(result.body)) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  const body = record(result.body);
  const fallback = STATUS_DEFAULTS[result.status] ?? STATUS_DEFAULTS[500];
  const details: Record<string, unknown> = {};
  if (typeof body?.scanId === "string") details.scanId = body.scanId;
  if (typeof body?.rawText === "string") details.rawText = body.rawText;

  const serverFailure = result.status >= 500;
  const code =
    !serverFailure && typeof body?.code === "string"
      ? body.code
      : fallback.code;
  const legacyMessage =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : null;
  const message = serverFailure
    ? fallback.message
    : (legacyMessage ?? fallback.message);

  return apiError(
    result.status,
    code,
    message,
    Object.keys(details).length > 0 ? details : undefined,
    { headers: result.headers },
  );
}
