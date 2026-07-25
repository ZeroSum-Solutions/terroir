import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import { CreateWineListItemBodySchema } from "@/lib/api/wine-list-item-schemas";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type CreateItemResult = {
  outcome:
    | "created"
    | "replay"
    | "not_found"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress";
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const CREATE_ITEM_OUTCOMES: CreateItemResult["outcome"][] = [
  "created",
  "replay",
  "not_found",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineListItemBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

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
          p_request_hash: createIdempotencyRequestHash(body),
        }
      : {};
    const valueArgs = {
      ...(body.glass_price === undefined ||
      body.glass_price === null
        ? {}
        : { p_glass_price: body.glass_price }),
      ...(body.bottle_price === undefined ||
      body.bottle_price === null
        ? {}
        : { p_bottle_price: body.bottle_price }),
      ...(body.name_override === undefined ||
      body.name_override === null
        ? {}
        : { p_name_override: body.name_override }),
    };
    const { data, error } = await supabase.rpc(
      "create_wine_list_item_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_section_id: body.section_id,
        p_wine_id: body.wine_id,
        ...valueArgs,
        ...keyedArgs,
      },
    );

    if (error) {
      if (!rawKey) throw error;
      captureCreateItemError(error, "idempotent-rpc");
      return apiError(
        503,
        "idempotency_unavailable",
        "Request idempotency is temporarily unavailable.",
      );
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | CreateItemResult
      | null;
    if (
      !row ||
      !CREATE_ITEM_OUTCOMES.includes(row.outcome) ||
      !Number.isInteger(row.response_status) ||
      row.response_status < 100 ||
      row.response_status > 599 ||
      typeof row.replayed !== "boolean" ||
      row.response_body === null ||
      row.response_body === undefined ||
      (row.outcome === "replay") !== row.replayed
    ) {
      const malformed = new Error(
        "create_wine_list_item_idempotent returned an invalid result",
      );
      if (!rawKey) throw malformed;
      captureCreateItemError(malformed, "idempotent-rpc-result");
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
      ["created", "not_found"].includes(row.outcome)
    ) {
      headers["Idempotency-Replayed"] = "false";
    }

    return apiResultResponse({
      status: row.response_status,
      body: row.response_body,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    });
  });
}

function captureCreateItemError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "wine-list-items", phase },
    });
  } catch {
    // Error reporting cannot replace the fail-closed or committed response.
  }
}
