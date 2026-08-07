import { NextResponse, type NextRequest } from "next/server";
import { apiError, Errors } from "@/lib/api/errors";
import { z } from "zod";
import {
  ReconcileExceedsSizeError,
  ReconcileForbiddenError,
  ReconcileInvalidRequestError,
  ReconcileNotFoundError,
  ReconcileRpcError,
  reconcileOpenBottles,
  revalidateReconcileResult,
} from "@/domains/cellar/reconcile-service";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

const EntrySchema = z.object({
  wine_id: z.string().uuid().transform((value) => value.toLowerCase()),
  // Upper bound is a sanity check against garbage (20L = larger than any
  // real bottle — Imperial is 6L). The per-wine size_ml check lives in
  // the RPC and raises P0002 → 400 EXCEEDS_SIZE.
  new_remaining_ml: z.number().int().min(0).max(20000),
  note: z.string().trim().max(500).optional(),
});

const BodySchema = z.object({
  entries: z.array(EntrySchema).min(1).max(100),
});

type ReconcileOutcome =
  | "reconciled"
  | "replay"
  | "exceeds_size"
  | "not_found"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type ReconcileResult = {
  outcome: ReconcileOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
  execution_started_at: string;
};

const RECONCILE_OUTCOMES: readonly ReconcileOutcome[] = [
  "reconciled",
  "replay",
  "exceeds_size",
  "not_found",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

/**
 * POST /api/reconcile
 *
 * BND-038 / BND-136. End-of-shift reconcile: batch-update open_bottles.remaining_ml
 * to match physical reality. Each entry becomes a `reconcile` pour_event
 * inserted by reconcile_open_bottle inside reconcile_open_bottles_batch —
 * the whole set runs in one PL/pgSQL transaction, so partial-apply is
 * impossible and retries are idempotent (a failed batch rolls back every
 * entry, not just the failing one).
 *
 * Role-gated to owner | manager via requireRole (endpoint-level 403 for staff).
 * The RPC also enforces role as defense-in-depth.
 *
 * 200: { updated: N }
 * 400: invalid body / empty entries / > 100 entries / remaining_ml > size_ml
 * 401: unauthenticated (from requireRole)
 * 403: role mismatch (staff rejected at endpoint; manager/owner required)
 * 404: a target wine or active bottle does not exist
 * 500: unhandled RPC failure
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postReconcile(request), { operation: "reconciliation" });
}

async function postReconcile(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const entries = parsed.data.entries;

  const rawKey = request.headers.get("Idempotency-Key");
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return Errors.badRequest(
      "Invalid Idempotency-Key.",
      undefined,
      "invalid_idempotency_key",
    );
  }

  try {
    const rawResult = await reconcileOpenBottles({
      supabase,
      restaurantId,
      entries,
      idempotencyKey: rawKey,
      requestHash: rawKey
        ? createIdempotencyRequestHash({ entries })
        : null,
    });
    if (!isReconcileResult(rawResult, entries.length)) {
      throw new ReconcileRpcError(
        "reconcile_open_bottles_idempotent returned an invalid result",
      );
    }

    const headers: Record<string, string> = {};
    if (rawResult.outcome === "idempotency_in_progress") {
      headers["Retry-After"] = "1";
    } else if (rawKey && rawResult.outcome === "replay") {
      headers["Idempotency-Replayed"] = "true";
    } else if (
      rawKey &&
      ["reconciled", "exceeds_size", "not_found"].includes(
        rawResult.outcome,
      )
    ) {
      headers["Idempotency-Replayed"] = "false";
    }

    if (rawResult.response_status === 200) {
      await revalidateReconcileResult({
        supabase,
        restaurantId,
        entries,
        sinceTs: rawResult.execution_started_at,
      });
    }

    return apiResultResponse({
      status: rawResult.response_status,
      body: rawResult.response_body,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    });
  } catch (error) {
    if (error instanceof ReconcileForbiddenError) {
      return Errors.forbidden("Forbidden.");
    }
    if (error instanceof ReconcileInvalidRequestError) {
      return Errors.badRequest(
        "Invalid reconcile request.",
        undefined,
        "invalid_reconcile_request",
      );
    }
    if (error instanceof ReconcileExceedsSizeError) {
      // "new_remaining_ml exceeds bottle size" — caller sent a bad
      // value. Surface as 400 so the UI can show "that's more than a
      // 750ml bottle can hold."
      return Errors.badRequest("new_remaining_ml exceeds bottle size.", undefined, "EXCEEDS_SIZE");
    }
    if (error instanceof ReconcileNotFoundError) {
      return Errors.notFound("Open bottle");
    }
    if (error instanceof ReconcileRpcError) {
      if (rawKey) return idempotencyUnavailable();
      return Errors.internal("Reconcile failed.");
    }
    throw error;
  }
}

function isReconcileResult(
  value: unknown,
  entryCount: number,
): value is ReconcileResult {
  if (
    !isRecord(value) ||
    typeof value.outcome !== "string" ||
    !RECONCILE_OUTCOMES.includes(value.outcome as ReconcileOutcome) ||
    !Number.isInteger(value.response_status) ||
    typeof value.replayed !== "boolean" ||
    typeof value.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(value.execution_started_at)) ||
    (value.outcome === "replay") !== value.replayed ||
    !isRecord(value.response_body)
  ) {
    return false;
  }

  if (value.outcome === "replay") {
    return isStoredReconcileResponse(
      value.response_status,
      value.response_body,
      entryCount,
    );
  }
  if (value.outcome === "reconciled") {
    return (
      value.response_status === 200 &&
      isUpdatedEnvelope(value.response_body, entryCount)
    );
  }
  if (value.outcome === "exceeds_size") {
    return (
      value.response_status === 400 &&
      isErrorEnvelope(
        value.response_body,
        "EXCEEDS_SIZE",
        "new_remaining_ml exceeds bottle size.",
      )
    );
  }
  if (value.outcome === "not_found") {
    return (
      value.response_status === 404 &&
      isErrorEnvelope(
        value.response_body,
        "not_found",
        "Open bottle not found.",
      )
    );
  }

  return (
    value.response_status === 409 &&
    isErrorEnvelope(
      value.response_body,
      value.outcome,
    )
  );
}

function isStoredReconcileResponse(
  status: unknown,
  body: Record<string, unknown>,
  entryCount: number,
): boolean {
  if (status === 200) return isUpdatedEnvelope(body, entryCount);
  if (status === 400) {
    return isErrorEnvelope(
      body,
      "EXCEEDS_SIZE",
      "new_remaining_ml exceeds bottle size.",
    );
  }
  if (status === 404) {
    return isErrorEnvelope(
      body,
      "not_found",
      "Open bottle not found.",
    );
  }
  return false;
}

function isUpdatedEnvelope(
  body: Record<string, unknown>,
  entryCount: number,
): boolean {
  return body.updated === entryCount;
}

function isErrorEnvelope(
  body: Record<string, unknown>,
  code: string,
  exactMessage?: string,
): boolean {
  if (!isRecord(body.error)) return false;
  return (
    body.error.code === code &&
    typeof body.error.message === "string" &&
    (exactMessage === undefined || body.error.message === exactMessage)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idempotencyUnavailable() {
  return apiError(
    503,
    "idempotency_unavailable",
    "Request idempotency is temporarily unavailable.",
  );
}
