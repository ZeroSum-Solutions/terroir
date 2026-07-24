import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { revalidateAutoEightysixedWines } from "@/lib/api/auto-eightysix-revalidation";
import { normalizeIsoUtcTimestamp } from "@/lib/api/iso-timestamp";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson, parseParams } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

const ParamsSchema = z.strictObject({ id: z.string().uuid() });
const BodySchema = z.strictObject({
  expected_opened_at: z
    .string()
    .datetime({ offset: true })
    .transform((value, context) => {
      try {
        return normalizeIsoUtcTimestamp(value);
      } catch {
        context.addIssue({
          code: "custom",
          message:
            "Timestamp must use at most PostgreSQL microsecond precision.",
        });
        return z.NEVER;
      }
    }),
});

type CloseBottleOutcome =
  | "closed"
  | "replay"
  | "not_found"
  | "stale_open_bottle"
  | "already_closed"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type CloseBottleResult = {
  outcome: CloseBottleOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

const CLOSE_BOTTLE_OUTCOMES: readonly CloseBottleOutcome[] = [
  "closed",
  "replay",
  "not_found",
  "stale_open_bottle",
  "already_closed",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

const ERROR_STATUS_BY_OUTCOME = {
  not_found: 404,
  stale_open_bottle: 409,
  already_closed: 409,
  idempotency_key_reused: 409,
  idempotency_key_expired: 409,
  idempotency_outcome_unknown: 409,
  idempotency_in_progress: 409,
} as const;

/**
 * POST /api/open-bottles/[id]/close
 *
 * Closes the exact bottle generation rendered to the user. The dedicated RPC
 * serializes a supplied Idempotency-Key and commits the spill, trigger-driven
 * close/auto-86 state, and stored response in one transaction.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(() => postCloseBottle(request, params));
}

async function postCloseBottle(
  request: NextRequest,
  params: Promise<{ id: string }>,
) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsedParams = await parseParams(params, ParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const bottleId = parsedParams.data.id.toLowerCase();

  const parsedBody = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsedBody.ok) return parsedBody.response;
  const expectedOpenedAt = parsedBody.data.expected_opened_at;

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
          bottle_id: bottleId,
          expected_opened_at: expectedOpenedAt,
        }),
    }
    : {};
  const closeStartedAt = new Date().toISOString();
  const { data, error } = await supabase.rpc(
    "close_open_bottle_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_bottle_id: bottleId,
      p_expected_opened_at: expectedOpenedAt,
      ...keyedArgs,
    },
  );

  if (error) {
    if (!rawKey) throw error;
    captureCloseBottleError(error, "idempotent-rpc");
    return idempotencyUnavailable();
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | CloseBottleResult
    | null;
  if (!isCloseBottleResult(row, bottleId)) {
    const malformed = new Error(
      "close_open_bottle_idempotent returned an invalid result",
    );
    if (!rawKey) throw malformed;
    captureCloseBottleError(malformed, "idempotent-rpc-result");
    return idempotencyUnavailable();
  }

  const headers: Record<string, string> = {};
  if (row.outcome === "idempotency_in_progress") {
    headers["Retry-After"] = "1";
  } else if (rawKey && row.outcome === "replay") {
    headers["Idempotency-Replayed"] = "true";
  } else if (
    rawKey &&
    ["closed", "not_found", "stale_open_bottle", "already_closed"].includes(
      row.outcome,
    )
  ) {
    headers["Idempotency-Replayed"] = "false";
  }

  if (row.response_status === 200) {
    for (const path of ["/cellar/open", "/cellar", "/availability"]) {
      try {
        revalidatePath(path);
      } catch (revalidationError) {
        captureCloseBottleError(revalidationError, `revalidate:${path}`);
      }
    }
    try {
      await revalidateAutoEightysixedWines({
        supabase,
        restaurantId,
        touchedWineIds: [closedWineId(row.response_body)],
        sinceTs: closeStartedAt,
      });
    } catch (revalidationError) {
      captureCloseBottleError(revalidationError, "revalidate:auto-eightysix");
    }
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function closedWineId(body: Json): string {
  if (!isRecord(body) || !isRecord(body.closed)) {
    throw new Error("Validated close response is missing its wine id");
  }
  return body.closed.wine_id as string;
}

function isCloseBottleResult(
  value: CloseBottleResult | null,
  bottleId: string,
): value is CloseBottleResult {
  if (
    !value ||
    !CLOSE_BOTTLE_OUTCOMES.includes(value.outcome) ||
    !Number.isInteger(value.response_status) ||
    typeof value.replayed !== "boolean" ||
    (value.outcome === "replay") !== value.replayed ||
    !isRecord(value.response_body)
  ) {
    return false;
  }

  if (value.outcome === "replay") {
    return isStoredCloseResponse(
      value.response_status,
      value.response_body,
      bottleId,
    );
  }

  if (value.outcome === "closed") {
    return (
      value.response_status === 200 &&
      isClosedEnvelope(value.response_body, bottleId)
    );
  }

  const expectedStatus =
    ERROR_STATUS_BY_OUTCOME[
      value.outcome as keyof typeof ERROR_STATUS_BY_OUTCOME
    ];
  return (
    value.response_status === expectedStatus &&
    isErrorCode(value.response_body, value.outcome)
  );
}

function isStoredCloseResponse(
  status: number,
  body: Record<string, Json | undefined>,
  bottleId: string,
): boolean {
  if (status === 200) return isClosedEnvelope(body, bottleId);
  if (status === 404) return isErrorCode(body, "not_found");
  if (status !== 409) return false;
  return (
    isErrorCode(body, "stale_open_bottle") ||
    isErrorCode(body, "already_closed")
  );
}

function isClosedEnvelope(
  body: Record<string, Json | undefined>,
  bottleId: string,
): boolean {
  const closed = body.closed;
  if (!isRecord(closed)) return false;
  return (
    closed.id === bottleId &&
    typeof closed.wine_id === "string" &&
    z.string().uuid().safeParse(closed.wine_id).success &&
    typeof closed.closed_at === "string" &&
    z.string().datetime({ offset: true }).safeParse(closed.closed_at).success
  );
}

function isErrorCode(
  body: Record<string, Json | undefined>,
  code: string,
): boolean {
  const error = body.error;
  return (
    isRecord(error) &&
    error.code === code &&
    typeof error.message === "string"
  );
}

function isRecord(
  value: Json | undefined,
): value is Record<string, Json | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idempotencyUnavailable() {
  return apiError(
    503,
    "idempotency_unavailable",
    "Request idempotency is temporarily unavailable.",
  );
}

function captureCloseBottleError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "open-bottles-close", phase },
    });
  } catch {
    // Observability and cache refresh cannot replace the committed response.
  }
}
