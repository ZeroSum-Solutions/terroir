import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Errors } from "./errors";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
  withIdempotency,
} from "./idempotency";
import { apiResultResponse } from "./result-response";
import type { Database } from "@/types/database";
import type { API_IDEMPOTENCY_IMPLEMENTATIONS } from "@/lib/auth/api-idempotency-policy";

type ImplementedOperation =
  keyof typeof API_IDEMPOTENCY_IMPLEMENTATIONS;

type MutationResult<T> = {
  status: number;
  body: T;
  headers?: Record<string, string>;
};

/**
 * Shared route boundary for implemented JSON and binary mutation commands.
 *
 * Parse and validate the request before calling this helper, then fingerprint
 * the normalized values (plus ordered binary parts when applicable). The
 * handler must contain the whole business mutation and return a JSON-safe
 * result. Missing keys preserve legacy behavior; malformed supplied keys fail
 * before any claim or business effect.
 */
export async function idempotentMutationResponse<T>(options: {
  request: Pick<NextRequest, "headers">;
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  operationId: ImplementedOperation;
  payload: unknown;
  binaryParts?: readonly Uint8Array[];
  handler: () => Promise<MutationResult<T>>;
  releaseOnError?: boolean;
}) {
  const rawKey = options.request.headers.get("Idempotency-Key");
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return Errors.badRequest(
      "Invalid Idempotency-Key.",
      undefined,
      "invalid_idempotency_key",
    );
  }

  const result = await withIdempotency({
    supabase: options.supabase,
    restaurantId: options.restaurantId,
    operationId: options.operationId,
    key: rawKey,
    requestHash: createIdempotencyRequestHash(
      options.payload,
      ...(options.binaryParts ?? []),
    ),
    handler: options.handler,
    releaseOnError: options.releaseOnError,
  });

  return apiResultResponse(result);
}
