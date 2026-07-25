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
import { parseParams } from "@/lib/api/validation";
import { WineListIdParamsSchema } from "@/lib/api/wine-list-lifecycle-schemas";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type CloneOutcome =
  | "cloned"
  | "not_found"
  | "replay"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type CloneResult = {
  outcome: CloneOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const CLONE_OUTCOMES: readonly CloneOutcome[] = [
  "cloned",
  "not_found",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const id = parsedParams.data.id.toLowerCase();

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
          p_request_hash: createIdempotencyRequestHash({ id }),
        }
      : {};
    const { data, error } = await supabase.rpc(
      "clone_wine_list_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_wine_list_id: id,
        ...keyedArgs,
      },
    );

    if (error) {
      if (error.code === "42501") return Errors.forbidden("Forbidden.");
      if (rawKey && error.code === "22023") {
        return Errors.badRequest(
          "Invalid wine-list clone request.",
          undefined,
          "invalid_wine_list_clone_request",
        );
      }
      captureCloneError(error, "clone-rpc", id);
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const row = firstResult(data);
    if (!isCloneResult(row, rawKey !== null)) {
      captureCloneError(
        new Error("clone_wine_list_idempotent returned an invalid result"),
        "clone-result",
        id,
      );
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const headers = idempotencyHeaders(row, rawKey !== null);
    return apiResultResponse({
      status: row.response_status,
      body: row.response_body,
      ...(headers ? { headers } : {}),
    });
  });
}

function firstResult(data: unknown): CloneResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as CloneResult | null;
}

function isCloneResult(
  row: CloneResult | null,
  isKeyed: boolean,
): row is CloneResult {
  if (
    !row ||
    !CLONE_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    typeof row.replayed !== "boolean" ||
    (row.outcome === "replay") !== row.replayed ||
    !isRecord(row.response_body) ||
    (!isKeyed && row.outcome.startsWith("idempotency_")) ||
    (!isKeyed && row.outcome === "replay")
  ) {
    return false;
  }

  if (row.outcome === "cloned") {
    return row.response_status === 200 && isUuid(row.response_body.id);
  }
  if (row.outcome === "replay") {
    return (
      (row.response_status === 200 && isUuid(row.response_body.id)) ||
      (row.response_status === 404 &&
        isErrorBody(row.response_body, "not_found"))
    );
  }

  const expected: Record<
    Exclude<CloneOutcome, "cloned" | "replay">,
    [number, string]
  > = {
    not_found: [404, "not_found"],
    idempotency_key_reused: [409, "idempotency_key_reused"],
    idempotency_key_expired: [409, "idempotency_key_expired"],
    idempotency_outcome_unknown: [409, "idempotency_outcome_unknown"],
    idempotency_in_progress: [409, "idempotency_in_progress"],
  };
  const [status, code] = expected[row.outcome];
  return (
    row.response_status === status &&
    isErrorBody(row.response_body, code)
  );
}

function idempotencyHeaders(
  row: CloneResult,
  isKeyed: boolean,
): Record<string, string> | null {
  if (row.outcome === "idempotency_in_progress") {
    return { "Retry-After": "1" };
  }
  if (!isKeyed) return null;
  if (row.outcome === "replay") {
    return { "Idempotency-Replayed": "true" };
  }
  if (["cloned", "not_found"].includes(row.outcome)) {
    return { "Idempotency-Replayed": "false" };
  }
  return null;
}

function isErrorBody(
  body: Record<string, unknown>,
  code: string,
): boolean {
  return (
    isRecord(body.error) &&
    body.error.code === code &&
    typeof body.error.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function captureCloneError(
  error: unknown,
  phase: string,
  listId: string,
): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "wine-list-clone", phase },
      extra: { listId },
    });
  } catch {
    // Error reporting cannot replace the fail-closed response.
  }
}
