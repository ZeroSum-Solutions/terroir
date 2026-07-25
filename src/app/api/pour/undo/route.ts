import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { revalidateUndonePour } from "@/domains/pours/pour-service";
import { requireMembership } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
});

type UndoLastPourResult = {
  outcome:
    | "undone"
    | "replay"
    | "not_found"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress";
  response_status: number;
  response_body: Json;
  replayed: boolean;
  execution_started_at: string;
};

const UNDO_LAST_POUR_OUTCOMES: UndoLastPourResult["outcome"][] = [
  "undone",
  "replay",
  "not_found",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

/**
 * POST /api/pour/undo
 *
 * BND-119. undo_last_pour_idempotent commits the caller-scoped idempotency
 * response and the existing undo_last_pour business transaction together.
 * Missing-key callers retain the same status, body, authorization, and error
 * behavior.
 *
 * 200: { open_bottle: { wine_id, remaining_ml, ... } }
 * 400: invalid body
 * 401: unauthenticated
 * 403: not a member
 * 404: no recent pour to undo
 * 500: any other RPC error
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postUndo(request));
}

async function postUndo(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id } = parsed.data;
  const normalizedWineId = wine_id.toLowerCase();

  const rawKey = request.headers.get("Idempotency-Key");
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return Errors.badRequest(
      "Invalid Idempotency-Key.",
      undefined,
      "invalid_idempotency_key",
    );
  }

  const keyedArgs = rawKey
    ? {
        p_idempotency_key: rawKey,
        p_request_hash: createIdempotencyRequestHash({
          wine_id: normalizedWineId,
        }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "undo_last_pour_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_wine_id: normalizedWineId,
      ...keyedArgs,
    },
  );

  if (error) {
    if (error.code === "42501") {
      return Errors.forbidden("Forbidden.");
    }
    captureUndoError(error, "idempotent-rpc");
    if (rawKey && error.code === "22023") {
      return Errors.badRequest(
        "Invalid undo request.",
        undefined,
        "invalid_undo_request",
      );
    }
    if (!rawKey) {
      return Errors.internal("Undo failed.");
    }
    return apiError(
      503,
      "idempotency_unavailable",
      "Request idempotency is temporarily unavailable.",
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | UndoLastPourResult
    | null;
  if (!isValidUndoLastPourResult(
    row,
    normalizedWineId,
    restaurantId,
    rawKey !== null,
  )) {
    const malformed = new Error(
      "undo_last_pour_idempotent returned an invalid result",
    );
    captureUndoError(malformed, "idempotent-rpc-result");
    if (!rawKey) return Errors.internal("Undo failed.");
    return apiError(
      503,
      "idempotency_unavailable",
      "Request idempotency is temporarily unavailable.",
    );
  }

  const headers: Record<string, string> = {};
  if (row.outcome === "idempotency_in_progress") {
    headers["Retry-After"] = "1";
  } else if (rawKey && row.outcome === "replay") {
    headers["Idempotency-Replayed"] = "true";
  } else if (
    rawKey &&
    ["undone", "not_found"].includes(row.outcome)
  ) {
    headers["Idempotency-Replayed"] = "false";
  }

  if (row.response_status === 200) {
    try {
      await revalidateUndonePour({
        supabase,
        restaurantId,
        wineId: normalizedWineId,
        sinceTs: row.execution_started_at,
      });
    } catch (revalidationError) {
      captureUndoError(revalidationError, "revalidate");
    }
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function captureUndoError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "pour", phase: `undo-${phase}` },
    });
  } catch {
    // Reporting cannot replace the fail-closed or committed response.
  }
}

function isValidUndoLastPourResult(
  row: UndoLastPourResult | null,
  wineId: string,
  restaurantId: string,
  isKeyed: boolean,
): row is UndoLastPourResult {
  if (
    !row ||
    !UNDO_LAST_POUR_OUTCOMES.includes(row.outcome) ||
    typeof row.replayed !== "boolean" ||
    typeof row.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(row.execution_started_at)) ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    return false;
  }

  const deterministic = new Map<UndoLastPourResult["outcome"], number>([
    ["undone", 200],
    ["not_found", 404],
    ["idempotency_key_reused", 409],
    ["idempotency_key_expired", 409],
    ["idempotency_outcome_unknown", 409],
    ["idempotency_in_progress", 409],
  ]);
  if (
    row.outcome === "replay"
      ? ![200, 404].includes(row.response_status)
      : deterministic.get(row.outcome) !== row.response_status
  ) {
    return false;
  }

  if (
    !isKeyed &&
    !["undone", "not_found"].includes(row.outcome)
  ) {
    return false;
  }

  const body = record(row.response_body);
  if (row.response_status === 200) {
    const bottle = record(body?.open_bottle);
    return (
      bottle?.wine_id === wineId &&
      bottle.restaurant_id === restaurantId &&
      typeof bottle.id === "string" &&
      Number.isInteger(bottle.remaining_ml) &&
      Number(bottle.remaining_ml) >= 0
    );
  }

  const error = record(body?.error);
  const expectedCode =
    row.outcome === "replay"
      ? "not_found"
      : row.outcome;
  return error?.code === expectedCode && typeof error.message === "string";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
