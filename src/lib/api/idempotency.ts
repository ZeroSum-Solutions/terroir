/**
 * Distributed request idempotency for authenticated API mutations.
 *
 * The database derives the actor from `auth.uid()` and scopes every key by
 * tenant, actor, and operation. A SHA-256 request hash prevents clients from
 * reusing one key for different input. Claim, replay, completion, and release
 * decisions are made by SECURITY DEFINER RPCs; clients cannot read or mutate
 * the backing table directly.
 *
 * The claim and business mutation are intentionally separate transactions.
 * Therefore a thrown handler leaves its claim in progress by default. That is
 * the fail-closed choice: a retry cannot duplicate a mutation whose commit
 * status is unknown. Callers may opt into release-on-error only when their
 * business operation is itself atomic and a throw proves it did not commit.
 */

import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyResult<T> = {
  status: number;
  body: T;
  replayed: boolean;
  headers?: Record<string, string>;
};

type ClaimOutcome =
  | "claimed"
  | "replay"
  | "in_progress"
  | "mismatch"
  | "expired"
  | "outcome_unknown";

type ClaimRow = {
  outcome: ClaimOutcome;
  response_status: number | null;
  response_body: Json | null;
  response_headers: Json | null;
};

const NON_REPLAYABLE_RESPONSE_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "idempotency-replayed",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function isValidIdempotencyKey(raw: string | null): raw is string {
  return (
    typeof raw === "string" &&
    raw.length >= 8 &&
    raw.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(raw)
  );
}

export function createIdempotencyRequestHash(
  payload: unknown,
  ...binaryParts: readonly Uint8Array[]
): string {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, Buffer.from(canonicalJson(payload), "utf8"));
  for (const part of binaryParts) {
    updateLengthPrefixed(hash, part);
  }
  return hash.digest("hex");
}

function updateLengthPrefixed(
  hash: ReturnType<typeof createHash>,
  bytes: Uint8Array,
): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Idempotency payload contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(
    `Unsupported idempotency payload value: ${typeof value}`,
  );
}

export async function withIdempotency<T>(options: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  operationId: string;
  key: string | null;
  requestHash: string;
  handler: () => Promise<{
    status: number;
    body: T;
    headers?: Record<string, string>;
  }>;
  releaseOnError?: boolean;
}): Promise<IdempotencyResult<T>> {
  const {
    supabase,
    restaurantId,
    operationId,
    key,
    requestHash,
    handler,
    releaseOnError = false,
  } = options;

  if (!key) {
    const result = await handler();
    return { ...result, replayed: false };
  }
  if (!isValidIdempotencyKey(key)) {
    throw new Error("Invalid Idempotency-Key reached idempotency core");
  }
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new Error("Invalid idempotency request hash");
  }

  let claim: ClaimRow;
  try {
    claim = await claimIdempotency({
      supabase,
      restaurantId,
      operationId,
      key,
      requestHash,
    });
  } catch (error) {
    captureStorageError(error, operationId, "claim");
    return unavailableResult<T>();
  }

  if (claim.outcome === "replay") {
    if (
      !Number.isInteger(claim.response_status) ||
      claim.response_status === null ||
      claim.response_status < 100 ||
      claim.response_status > 599
    ) {
      const error = new Error(
        "Idempotency replay returned an invalid status",
      );
      captureStorageError(error, operationId, "replay");
      return unavailableResult<T>();
    }
    let replayHeaders: Record<string, string>;
    try {
      replayHeaders = parseReplayableResponseHeaders(claim.response_headers);
    } catch (error) {
      captureStorageError(error, operationId, "replay");
      return unavailableResult<T>();
    }
    return {
      status: claim.response_status,
      body: claim.response_body as T,
      replayed: true,
      headers: {
        ...replayHeaders,
        "Idempotency-Replayed": "true",
      },
    };
  }
  if (claim.outcome === "in_progress") {
    return {
      status: 409,
      body: {
        error: {
          code: "idempotency_in_progress",
          message: "A request with this Idempotency-Key is still in progress.",
        },
      } as T,
      replayed: false,
      headers: { "Retry-After": "1" },
    };
  }
  if (claim.outcome === "mismatch") {
    return {
      status: 409,
      body: {
        error: {
          code: "idempotency_key_reused",
          message:
            "This Idempotency-Key was already used for a different request.",
        },
      } as T,
      replayed: false,
    };
  }
  if (claim.outcome === "expired") {
    return {
      status: 409,
      body: {
        error: {
          code: "idempotency_key_expired",
          message: "This Idempotency-Key has expired.",
        },
      } as T,
      replayed: false,
    };
  }
  if (claim.outcome === "outcome_unknown") {
    return {
      status: 409,
      body: {
        error: {
          code: "idempotency_outcome_unknown",
          message:
            "The original request outcome is unknown and will not be retried.",
        },
      } as T,
      replayed: false,
    };
  }

  let result: {
    status: number;
    body: T;
    headers?: Record<string, string>;
  };
  try {
    result = await handler();
  } catch (error) {
    if (releaseOnError) {
      await releaseClaim({
        supabase,
        restaurantId,
        operationId,
        key,
        requestHash,
        originalError: error,
      });
    } else {
      await markOutcomeUnknown({
        supabase,
        restaurantId,
        operationId,
        key,
        requestHash,
        originalError: error,
      });
    }
    throw error;
  }

  let responseHeaders: Record<string, string>;
  try {
    responseHeaders = parseReplayableResponseHeaders(result.headers ?? {});
  } catch (error) {
    captureStorageError(error, operationId, "response-validation");
    await markOutcomeUnknown({
      supabase,
      restaurantId,
      operationId,
      key,
      requestHash,
      originalError: error,
    });
    return unavailableResult<T>();
  }

  try {
    const { data, error } = await supabase.rpc("complete_api_idempotency", {
      p_restaurant_id: restaurantId,
      p_operation_id: operationId,
      p_idempotency_key: key,
      p_request_hash: requestHash,
      p_response_status: result.status,
      p_response_body: result.body as unknown as Json,
      p_response_headers: responseHeaders as Json,
    });
    if (error) throw error;
    if (data !== true) {
      throw new Error("Idempotency completion did not update its owned claim");
    }
  } catch (error) {
    captureStorageError(error, operationId, "complete");
    return unavailableResult<T>();
  }

  return {
    ...result,
    replayed: false,
    headers: {
      ...responseHeaders,
      "Idempotency-Replayed": "false",
    },
  };
}

async function claimIdempotency(options: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  operationId: string;
  key: string;
  requestHash: string;
}): Promise<ClaimRow> {
  const { data, error } = await options.supabase.rpc(
    "claim_api_idempotency",
    {
      p_restaurant_id: options.restaurantId,
      p_operation_id: options.operationId,
      p_idempotency_key: options.key,
      p_request_hash: options.requestHash,
    },
  );
  if (error) throw error;

  const candidate = Array.isArray(data) ? data[0] : data;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    ![
      "claimed",
      "replay",
      "in_progress",
      "mismatch",
      "expired",
      "outcome_unknown",
    ].includes(
      String((candidate as ClaimRow).outcome),
    )
  ) {
    throw new Error("claim_api_idempotency returned an invalid result");
  }
  return candidate as ClaimRow;
}

async function markOutcomeUnknown(options: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  operationId: string;
  key: string;
  requestHash: string;
  originalError: unknown;
}): Promise<void> {
  try {
    const { data, error } = await options.supabase.rpc(
      "fail_api_idempotency",
      {
        p_restaurant_id: options.restaurantId,
        p_operation_id: options.operationId,
        p_idempotency_key: options.key,
        p_request_hash: options.requestHash,
      },
    );
    if (!error && data === true) return;

    captureStorageError(
      error ??
        new Error("Idempotency failure marker did not update its owned claim"),
      options.operationId,
      "fail-unknown",
      options.originalError,
    );
  } catch (error) {
    captureStorageError(
      error,
      options.operationId,
      "fail-unknown",
      options.originalError,
    );
  }
}

async function releaseClaim(options: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  operationId: string;
  key: string;
  requestHash: string;
  originalError: unknown;
}): Promise<void> {
  const { data, error } = await options.supabase.rpc(
    "release_api_idempotency",
    {
      p_restaurant_id: options.restaurantId,
      p_operation_id: options.operationId,
      p_idempotency_key: options.key,
      p_request_hash: options.requestHash,
    },
  );
  if (!error && data === true) return;

  const releaseError =
    error ?? new Error("Idempotency release did not remove its owned claim");
  captureStorageError(
    releaseError,
    options.operationId,
    "release",
    options.originalError,
  );
  throw releaseError;
}

function parseReplayableResponseHeaders(
  value: Json | Record<string, string> | null,
): Record<string, string> {
  if (value === null) return {};
  if (Array.isArray(value) || typeof value !== "object") {
    throw new Error("Idempotency replay returned invalid response headers");
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (
      typeof headerValue !== "string" ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
      /[\u0000-\u0008\u000A-\u001F\u007F]/.test(headerValue) ||
      NON_REPLAYABLE_RESPONSE_HEADERS.has(normalizedName)
    ) {
      throw new Error("Idempotency replay returned invalid response headers");
    }
    headers[name] = headerValue;
  }
  return headers;
}

function unavailableResult<T>(): IdempotencyResult<T> {
  return {
    status: 503,
    body: {
      error: {
        code: "idempotency_unavailable",
        message: "Request idempotency is temporarily unavailable.",
      },
    } as T,
    replayed: false,
  };
}

function captureStorageError(
  error: unknown,
  operationId: string,
  phase: string,
  originalError?: unknown,
): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "idempotency", phase },
      extra: {
        operationId,
        ...(originalError === undefined
          ? {}
          : {
              originalError:
                originalError instanceof Error
                  ? originalError.message
                  : String(originalError),
            }),
      },
    });
  } catch {
    // Error reporting cannot replace the fail-closed API result.
  }
}
