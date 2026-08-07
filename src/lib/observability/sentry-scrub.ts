/**
 * Final privacy boundary for Sentry events. Route code must still avoid adding
 * PII, but this allowlist removes request payloads, free text, scanner content,
 * headers, users, and secret-shaped context if a future caller forgets.
 */
const SENSITIVE_KEY = /(?:authorization|cookie|email|password|secret|token|api[_-]?key|dsn|url|body|stack|message|data|invoice|ocr|raw|image|file|path)/i;
const SAFE_TEXT_KEY = /^(?:event_id|platform|level|logger|release|dist|environment|service|surface|stage|phase|code|operation|outcome|status|type|name|version|request_id|restaurant_id|job_id|provider_id|scan_id|list_id|metric_name)$/;
const SAFE_TEXT_VALUE = /^[A-Za-z0-9_.:/-]{1,160}$/;

function scrub(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return SAFE_TEXT_KEY.test(key) && SAFE_TEXT_VALUE.test(value)
      ? value
      : "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, childValue]) => [childKey, scrub(childValue, childKey)],
      ),
    );
  }
  return "[REDACTED]";
}

export function scrubSentryEvent<T extends object>(event: T): T {
  const {
    request: _request,
    user: _user,
    contexts: _contexts,
    message: _message,
    breadcrumbs: _breadcrumbs,
    transaction: _transaction,
    spans: _spans,
    exception: _exception,
    ...safeEvent
  } = event as Record<string, unknown>;
  // Keep a stable exception type for grouping, but never preserve an error
  // message or frame locals because providers can embed invoice/customer data.
  const exceptionValues =
    _exception && typeof _exception === "object"
      ? (_exception as { values?: unknown }).values
      : undefined;
  const exception = Array.isArray(exceptionValues)
    ? {
        values: exceptionValues.map((value) => ({
          type:
            typeof (value as { type?: unknown })?.type === "string" &&
            SAFE_TEXT_VALUE.test((value as { type: string }).type)
              ? (value as { type: string }).type
              : "Error",
        })),
      }
    : undefined;
  return {
    ...(scrub(safeEvent) as Record<string, unknown>),
    ...(exception ? { exception } : {}),
  } as T;
}
