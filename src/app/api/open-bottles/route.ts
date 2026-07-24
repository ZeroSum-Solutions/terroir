import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
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

type OpenBottleResult = {
  outcome:
    | "opened"
    | "replay"
    | "not_found"
    | "no_sealed_stock"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress";
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const OPEN_BOTTLE_OUTCOMES: OpenBottleResult["outcome"][] = [
  "opened",
  "replay",
  "not_found",
  "no_sealed_stock",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

/**
 * POST /api/open-bottles
 *
 * Atomically decrements one sealed inventory unit and opens or replaces the
 * active bottle without recording a pour event. Any member (staff+) may use
 * the command. A supplied Idempotency-Key binds the logical wine-open action
 * and prevents a lost response from consuming another sealed bottle.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postOpenBottle(request));
}

async function postOpenBottle(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id } = parsed.data;

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
        p_request_hash: createIdempotencyRequestHash({ wine_id }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "open_bottle_from_inventory_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_wine_id: wine_id,
      ...keyedArgs,
    },
  );

  if (error) {
    if (!rawKey) throw error;
    captureOpenBottleError(error, "idempotent-rpc");
    return apiError(
      503,
      "idempotency_unavailable",
      "Request idempotency is temporarily unavailable.",
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | OpenBottleResult
    | null;
  if (
    !row ||
    !OPEN_BOTTLE_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    row.response_status < 100 ||
    row.response_status > 599 ||
    typeof row.replayed !== "boolean" ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    const malformed = new Error(
      "open_bottle_from_inventory_idempotent returned an invalid result",
    );
    if (!rawKey) throw malformed;
    captureOpenBottleError(malformed, "idempotent-rpc-result");
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
    ["opened", "not_found", "no_sealed_stock"].includes(row.outcome)
  ) {
    headers["Idempotency-Replayed"] = "false";
  }

  if (row.response_status === 201) {
    try {
      revalidatePath("/cellar/open");
    } catch (error) {
      captureOpenBottleError(error, "revalidate");
    }
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function captureOpenBottleError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "open-bottles", phase },
    });
  } catch {
    // Error reporting cannot replace the fail-closed or committed response.
  }
}
