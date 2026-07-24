const RETAIN_KEY_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_outcome_unknown",
  "idempotency_unavailable",
]);

export function readApiErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Keep one logical action's key across transient or outcome-ambiguous errors.
 * Deterministic client errors release it so corrected input starts a new
 * logical request instead of conflicting with the old request hash.
 */
export function shouldRetainIdempotencyKey(
  status: number,
  errorCode: string | null,
): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    (errorCode !== null && RETAIN_KEY_CODES.has(errorCode))
  );
}
