import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  revalidateRecordedPour,
} from "@/domains/pours/pour-service";
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
  ml: z.number().int().positive().max(2000),
  kind: z.enum(["pour", "spill"]).default("pour"),
  note: z.string().trim().max(500).optional(),
});

type RecordPourResult = {
  outcome:
    | "poured"
    | "replay"
    | "no_inventory"
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

const RECORD_POUR_OUTCOMES: RecordPourResult["outcome"][] = [
  "poured",
  "replay",
  "no_inventory",
  "not_found",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

/**
 * POST /api/pour
 *
 * BND-038. Records a pour (or spill) against the wine's open bottle.
 * record_pour_idempotent commits the caller-scoped idempotency response and
 * the existing record_pour business transaction together. Missing-key callers
 * retain the same status, body, authorization, and error behavior.
 *
 * 200: { open_bottle: { wine_id, remaining_ml, opened_at, ... } }
 * 400: invalid body
 * 401: unauthenticated (from requireMembership)
 * 403: caller not a member of this wine's restaurant (from RPC)
 * 404: target wine does not exist
 * 409: NO_INVENTORY — no sealed bottles to open (from RPC)
 * 500: any other RPC error (also reported to Sentry)
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postPour(request));
}

async function postPour(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id, ml, kind, note } = parsed.data;
  const normalizedWineId = wine_id.toLowerCase();
  const normalizedNote = note && note.length > 0 ? note : null;

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
          ml,
          kind,
          note: normalizedNote,
        }),
      }
    : {};
  const { data, error } = await supabase.rpc("record_pour_idempotent", {
    p_restaurant_id: restaurantId,
    p_wine_id: normalizedWineId,
    p_ml: ml,
    p_kind: kind,
    p_note: normalizedNote as unknown as string,
    ...keyedArgs,
  });

  if (error) {
    if (error.code === "42501") {
      return Errors.forbidden("Forbidden.");
    }
    capturePourError(error, "idempotent-rpc");
    if (rawKey && error.code === "22023") {
      return Errors.badRequest(
        "Invalid pour request.",
        undefined,
        "invalid_pour_request",
      );
    }
    if (!rawKey) {
      return Errors.internal("Pour failed.");
    }
    return apiError(
      503,
      "idempotency_unavailable",
      "Request idempotency is temporarily unavailable.",
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | RecordPourResult
    | null;
  if (!isValidRecordPourResult(row, normalizedWineId, rawKey !== null)) {
    const malformed = new Error(
      "record_pour_idempotent returned an invalid result",
    );
    capturePourError(malformed, "idempotent-rpc-result");
    if (!rawKey) return Errors.internal("Pour failed.");
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
    ["poured", "no_inventory", "not_found"].includes(row.outcome)
  ) {
    headers["Idempotency-Replayed"] = "false";
  }

  if (row.response_status === 200) {
    try {
      await revalidateRecordedPour({
        supabase,
        restaurantId,
        wineId: normalizedWineId,
        sinceTs: row.execution_started_at,
      });
    } catch (revalidationError) {
      capturePourError(revalidationError, "revalidate");
    }
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function capturePourError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "pour", phase },
    });
  } catch {
    // Reporting cannot replace the fail-closed or committed response.
  }
}

function isValidRecordPourResult(
  row: RecordPourResult | null,
  wineId: string,
  isKeyed: boolean,
): row is RecordPourResult {
  if (
    !row ||
    !RECORD_POUR_OUTCOMES.includes(row.outcome) ||
    typeof row.replayed !== "boolean" ||
    typeof row.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(row.execution_started_at)) ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    return false;
  }

  const deterministic = new Map<RecordPourResult["outcome"], number>([
    ["poured", 200],
    ["no_inventory", 409],
    ["not_found", 404],
    ["idempotency_key_reused", 409],
    ["idempotency_key_expired", 409],
    ["idempotency_outcome_unknown", 409],
    ["idempotency_in_progress", 409],
  ]);
  if (
    row.outcome === "replay"
      ? ![200, 404, 409].includes(row.response_status)
      : deterministic.get(row.outcome) !== row.response_status
  ) {
    return false;
  }

  if (
    !isKeyed &&
    !["poured", "no_inventory", "not_found"].includes(row.outcome)
  ) {
    return false;
  }

  const body = record(row.response_body);
  if (row.response_status === 200) {
    return record(body?.open_bottle)?.wine_id === wineId;
  }

  const error = record(body?.error);
  const expectedCode =
    row.outcome === "replay"
      ? row.response_status === 404
        ? "not_found"
        : "no_inventory"
      : row.outcome;
  return error?.code === expectedCode && typeof error.message === "string";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
