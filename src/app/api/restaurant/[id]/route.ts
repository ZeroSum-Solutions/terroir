import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireOwner } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  verifyActiveRestaurantMembership,
  writeActiveRestaurantResponseCookie,
} from "@/lib/api/active-restaurant";
import { resolveActiveMembership } from "@/lib/api/resolve-active-membership";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;
const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireAuth();
    if (auth instanceof NextResponse) return auth;
    const { supabase, user } = auth;
    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: membership, error } = await supabase
      .from("memberships")
      .select("role, restaurants(name)")
      .eq("user_id", user.id)
      .eq("restaurant_id", id)
      .maybeSingle();
    if (error) throw error;
    if (!membership) {
      return Errors.forbidden("Not a member of this restaurant.");
    }

    const restaurant = membership.restaurants as { name: string } | null;
    return NextResponse.json({
      id,
      name: restaurant?.name ?? "My Restaurant",
      role: membership.role,
    });
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireAuth({ rateLimit: "mutation" });
    if (auth instanceof NextResponse) return auth;
    const { supabase, user } = auth;
    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const id = parsedParams.data.id.toLowerCase();

    const key = validateIdempotencyKey(request);
    if (key instanceof NextResponse) return key;

    // Authorize before claiming: claim_api_idempotency intentionally rejects
    // foreign restaurant ids, but its storage error must not turn a routine
    // membership denial into a retryable 503 for keyed callers. Rechecking on
    // replay also prevents a stale successful switch from reissuing a cookie
    // after the membership has been removed.
    const membership = await verifyActiveRestaurantMembership(
      supabase,
      user.id,
      id,
    );
    if (!membership.ok) {
      if (membership.reason === "not_member") {
        return Errors.forbidden("Not a member of this restaurant.");
      }
      throw membership.cause;
    }

    const response = await idempotentMutationResponse<{
      ok: true;
      restaurantId: string;
    }>({
      request,
      supabase,
      restaurantId: id,
      operationId: "api:PUT:/api/restaurant/{param}",
      payload: { id },
      releaseOnError: false,
      handler: async () => ({
        status: 200,
        body: { ok: true as const, restaurantId: id },
      }),
    });

    if (response.status === 200) {
      writeActiveRestaurantResponseCookie(response, id);
    }
    return response;
  });
}

// BND-037b + BND-040: PATCH accepts auto-86 columns AND pricing target
// columns. BND-173: added eightysix_strategy for hide-vs-mark on /list/[slug].
const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    auto_eightysix_from_inventory: z.boolean().optional(),
    eightysix_ml_threshold: z.number().int().min(0).max(5000).optional(),
    default_target_pour_cost_pct: z.number().gt(0).lt(100).optional(),
    default_target_markup_ratio: z.number().gte(1).lte(10).optional(),
    // BND-173 — how 86'd wines appear on public lists
    eightysix_strategy: z.enum(["hide", "mark"]).optional(),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireOwner();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;
    const parsedParams = await parseParams(params, ParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;
    if (id !== restaurantId) return Errors.forbidden("Forbidden.");

    const parsed = await parseJson(request, PatchSchema, {
      message: "Invalid body.",
    });
    if (!parsed.ok) return parsed.response;
    if (Object.keys(parsed.data).length === 0) {
      return Errors.badRequest("No valid fields.");
    }

    return idempotentMutationResponse({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/restaurant/{param}",
      payload: { id, ...parsed.data },
      releaseOnError: false,
      handler: async () => {
        const { error } = await supabase
          .from("restaurants")
          .update(parsed.data)
          .eq("id", id);
        if (error) throw error;

        return { status: 200, body: { ok: true } };
      },
    });
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(() => deleteRestaurant(request, params));
}

type DeleteRestaurantResult = {
  outcome:
    | "deleted"
    | "replay"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress"
    | "no_membership"
    | "owner_required"
    | "forbidden";
  response_status: number;
  response_body: Json;
  replayed: boolean;
  execution_started_at: string;
};

async function deleteRestaurant(
  request: NextRequest,
  params: Params,
): Promise<Response> {
  const auth = await requireAuth({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, user } = auth;

  const parsedParams = await parseParams(params, ParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const id = parsedParams.data.id.toLowerCase();

  const key = validateIdempotencyKey(request);
  if (key instanceof NextResponse) return key;

  // A completed deletion has already removed the membership row. The RPC
  // checks an owned prior claim before authorizing a new command, while new
  // commands still have to match the active restaurant and owner role inside
  // the same transaction as the delete.
  const activeMembership = await resolveActiveMembership(supabase, user.id);
  const keyedArgs = key
    ? {
        p_idempotency_key: key,
        p_request_hash: createIdempotencyRequestHash({ id }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "delete_restaurant_idempotent",
    {
      p_restaurant_id: id,
      ...(activeMembership
        ? {
            p_active_restaurant_id:
              activeMembership.restaurantId,
          }
        : {}),
      ...keyedArgs,
    },
  );

  if (error) {
    captureDeleteRestaurantError(error, "rpc");
    if (key && error.code === "22023") {
      return Errors.badRequest(
        "Invalid restaurant deletion request.",
        undefined,
        "invalid_restaurant_deletion_request",
      );
    }
    return unavailableOrInternal(key);
  }

  const row = firstDeleteResult(data);
  if (!isValidDeleteRestaurantResult(row, key !== null)) {
    captureDeleteRestaurantError(
      new Error("delete_restaurant_idempotent returned an invalid result"),
      "result",
    );
    return unavailableOrInternal(key);
  }

  return deleteResultResponse(row, key);
}

function validateIdempotencyKey(
  request: NextRequest,
): string | null | NextResponse {
  const rawKey = request.headers.get("Idempotency-Key");
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return Errors.badRequest(
      "Invalid Idempotency-Key.",
      undefined,
      "invalid_idempotency_key",
    );
  }
  return rawKey;
}

function firstDeleteResult(data: unknown): DeleteRestaurantResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as DeleteRestaurantResult | null;
}

function deleteResultResponse(
  row: DeleteRestaurantResult,
  key: string | null,
): Response {
  const headers: Record<string, string> = {};
  if (row.outcome === "idempotency_in_progress") {
    headers["Retry-After"] = "1";
  } else if (key && row.outcome === "replay") {
    headers["Idempotency-Replayed"] = "true";
  } else if (key && row.outcome === "deleted") {
    headers["Idempotency-Replayed"] = "false";
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function unavailableOrInternal(key: string | null): Response {
  if (!key) return Errors.internal();
  return apiError(
    503,
    "idempotency_unavailable",
    "Request idempotency is temporarily unavailable.",
  );
}

function isValidDeleteRestaurantResult(
  row: DeleteRestaurantResult | null,
  isKeyed: boolean,
): row is DeleteRestaurantResult {
  if (
    !row ||
    typeof row.replayed !== "boolean" ||
    typeof row.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(row.execution_started_at)) ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    return false;
  }

  const expectedStatuses: Partial<
    Record<DeleteRestaurantResult["outcome"], number>
  > = {
    deleted: 200,
    idempotency_key_reused: 409,
    idempotency_key_expired: 409,
    idempotency_outcome_unknown: 409,
    idempotency_in_progress: 409,
    no_membership: 403,
    owner_required: 403,
    forbidden: 403,
  };
  if (
    row.outcome === "replay"
      ? row.response_status !== 200
      : expectedStatuses[row.outcome] !== row.response_status
  ) {
    return false;
  }
  if (
    !isKeyed &&
    ![
      "deleted",
      "no_membership",
      "owner_required",
      "forbidden",
    ].includes(row.outcome)
  ) {
    return false;
  }

  const body = record(row.response_body);
  if (row.response_status === 200) {
    return body?.ok === true && Object.keys(body).length === 1;
  }

  const error = record(body?.error);
  if (
    !error ||
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    Object.keys(error).length !== 2 ||
    Object.keys(body ?? {}).length !== 1
  ) {
    return false;
  }
  if (row.response_status === 403) {
    const messageForOutcome: Partial<
      Record<DeleteRestaurantResult["outcome"], string>
    > = {
      no_membership: "No restaurant membership found.",
      owner_required: "Owner access required.",
      forbidden: "Forbidden.",
    };
    return (
      error.code === "forbidden" &&
      error.message === messageForOutcome[row.outcome]
    );
  }
  return (
    row.response_status === 409 &&
    error.code ===
      (row.outcome === "idempotency_in_progress"
        ? "idempotency_in_progress"
        : row.outcome === "idempotency_outcome_unknown"
          ? "idempotency_outcome_unknown"
          : row.outcome === "idempotency_key_expired"
            ? "idempotency_key_expired"
            : "idempotency_key_reused")
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function captureDeleteRestaurantError(
  error: unknown,
  phase: string,
): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "restaurant-delete-idempotency", phase },
    });
  } catch {
    // Observability must never replace the fail-closed API response.
  }
}
