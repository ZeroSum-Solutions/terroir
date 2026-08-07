/**
 * Final privacy boundary for Sentry events. Route code must still avoid adding
 * PII, but this removes request payloads, headers, users, and secret-shaped
 * context if a future caller forgets that rule.
 */
const SENSITIVE_KEY = /(?:authorization|cookie|email|password|secret|token|api[_-]?key|dsn|url|body|stack)/i;

function scrub(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, scrub(childValue, childKey)]));
  return "[REDACTED]";
}

export function scrubSentryEvent<T extends object>(event: T): T {
  const {
    request: _request,
    user: _user,
    contexts: _contexts,
    message: _message,
    exception: _exception,
    ...safeEvent
  } = event as Record<string, unknown>;
  // Keep a stable exception type for grouping, but never preserve an error
  // message because drivers and providers can embed request data in it.
  const exceptionValues = _exception && typeof _exception === "object"
    ? (_exception as { values?: unknown }).values
    : undefined;
  const exception = Array.isArray(exceptionValues)
    ? {
        values: exceptionValues.map((value) => ({
          type: typeof (value as { type?: unknown })?.type === "string"
            ? (value as { type: string }).type
            : "Error",
        })),
      }
    : undefined;
  return { ...scrub(safeEvent) as Record<string, unknown>, ...(exception ? { exception } : {}) } as T;
}
