import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson, parseParams } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;
const ParamsSchema = z.strictObject({ id: z.string().uuid() });
const BodySchema = z.strictObject({
  quantity: z.number().int().min(0).max(100000),
  reason: z.string().trim().min(1).max(500),
});

type QuantityAdjustmentOutcome =
  | "adjusted"
  | "unchanged"
  | "not_found"
  | "replay"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type QuantityAdjustmentResult = {
  outcome: QuantityAdjustmentOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const OUTCOMES: readonly QuantityAdjustmentOutcome[] = [
  "adjusted",
  "unchanged",
  "not_found",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;

    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, BodySchema);
    if (!parsedBody.ok) return parsedBody.response;

    const wineId = parsedParams.data.id.toLowerCase();
    const { quantity, reason } = parsedBody.data;
    const rawKey = request.headers.get("Idempotency-Key");
    if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
      return Errors.badRequest(
        "Invalid Idempotency-Key.",
        undefined,
        "invalid_idempotency_key",
      );
    }

    const { data, error } = await auth.supabase.rpc(
      "adjust_cellar_quantity_idempotent",
      {
        p_restaurant_id: auth.restaurantId,
        p_wine_id: wineId,
        p_quantity: quantity,
        p_reason: reason,
        ...(rawKey
          ? {
              p_idempotency_key: rawKey,
              p_request_hash: createIdempotencyRequestHash({
                id: wineId,
                quantity,
                reason,
              }),
            }
          : {}),
      },
    );
    if (error) {
      if (error.code === "42501") return Errors.forbidden("Forbidden.");
      if (error.code === "22023") {
        return Errors.badRequest(
          "Invalid cellar quantity adjustment.",
          undefined,
          "invalid_quantity_adjustment",
        );
      }
      Sentry.captureException(error, {
        tags: { surface: "cellar", phase: "quantity-adjustment" },
        extra: { restaurantId: auth.restaurantId, wineId },
      });
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const result = firstResult(data);
    if (!isValidResult(result, rawKey !== null)) {
      Sentry.captureException(
        new Error("adjust_cellar_quantity_idempotent returned an invalid result"),
        {
          tags: { surface: "cellar", phase: "quantity-adjustment-result" },
          extra: { restaurantId: auth.restaurantId, wineId },
        },
      );
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    return apiResultResponse({
      status: result.response_status,
      body: result.response_body,
      ...(responseHeaders(result, rawKey !== null)
        ? { headers: responseHeaders(result, rawKey !== null)! }
        : {}),
    });
  });
}

function firstResult(data: unknown): QuantityAdjustmentResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as QuantityAdjustmentResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidResult(
  result: QuantityAdjustmentResult | null,
  isKeyed: boolean,
): result is QuantityAdjustmentResult {
  if (
    !result ||
    !OUTCOMES.includes(result.outcome) ||
    !Number.isInteger(result.response_status) ||
    typeof result.replayed !== "boolean" ||
    !isRecord(result.response_body) ||
    (result.outcome === "replay") !== result.replayed ||
    (!isKeyed &&
      (result.outcome === "replay" || result.outcome.startsWith("idempotency_")))
  ) {
    return false;
  }
  if (result.outcome === "adjusted" || result.outcome === "unchanged") {
    return result.response_status === 200;
  }
  if (result.outcome === "not_found") return result.response_status === 404;
  if (result.outcome === "replay") return [200, 404].includes(result.response_status);
  return result.response_status === 409;
}

function responseHeaders(
  result: QuantityAdjustmentResult,
  isKeyed: boolean,
): Record<string, string> | null {
  if (result.outcome === "idempotency_in_progress") return { "Retry-After": "1" };
  if (!isKeyed) return null;
  if (result.outcome === "replay") return { "Idempotency-Replayed": "true" };
  if (["adjusted", "unchanged", "not_found"].includes(result.outcome)) {
    return { "Idempotency-Replayed": "false" };
  }
  return null;
}
