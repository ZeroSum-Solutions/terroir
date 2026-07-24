type ApiErrorDetails = {
  rawText?: string;
};

type ApiErrorPayload = {
  error?: string | {
    message?: string;
    details?: ApiErrorDetails;
  };
  message?: string;
  rawText?: string;
};

export function readApiError(
  payload: unknown,
  fallback: string,
): { message: string; rawText?: string } {
  const body = payload as ApiErrorPayload | null;
  const nested =
    body?.error && typeof body.error === "object" ? body.error : null;
  return {
    message:
      nested?.message ??
      body?.message ??
      (typeof body?.error === "string" ? body.error : null) ??
      fallback,
    rawText: nested?.details?.rawText ?? body?.rawText,
  };
}
