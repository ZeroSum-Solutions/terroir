import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import {
  TeamIdParamsSchema,
  UpdateMemberRoleBodySchema,
} from "@/lib/api/team-schemas";
import { parseJson, parseParams } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type TeamMemberMutationResult = {
  outcome:
    | "updated"
    | "removed"
    | "not_found"
    | "last_owner"
    | "self_removal"
    | "replay"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress";
  response_status: number;
  response_body: Json;
  replayed: boolean;
  execution_started_at: string;
};

const PATCH_OUTCOMES: TeamMemberMutationResult["outcome"][] = [
  "updated",
  "not_found",
  "last_owner",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

const DELETE_OUTCOMES: TeamMemberMutationResult["outcome"][] = [
  "removed",
  "not_found",
  "self_removal",
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
  return withApiHandler(() => updateMemberRole(request, params));
}

async function updateMemberRole(
  request: NextRequest,
  params: Params,
): Promise<Response> {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsedParams = await parseParams(params, TeamIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const memberId = parsedParams.data.id.toLowerCase();

  const parsedBody = await parseJson(request, UpdateMemberRoleBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const role = parsedBody.data.role;

  const key = validateIdempotencyKey(request);
  if (key instanceof NextResponse) return key;

  const keyedArgs = key
    ? {
        p_idempotency_key: key,
        p_request_hash: createIdempotencyRequestHash({
          id: memberId,
          role,
        }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "update_team_member_role_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_member_id: memberId,
      p_role: role,
      ...keyedArgs,
    },
  );

  if (error) {
    if (error.code === "42501") return Errors.forbidden("Forbidden.");
    captureTeamMemberError(error, "update-rpc");
    if (key && error.code === "22023") {
      return Errors.badRequest(
        "Invalid team member role request.",
        undefined,
        "invalid_team_member_role_request",
      );
    }
    return unavailableOrInternal(key);
  }

  const row = firstResult(data);
  if (!isValidTeamMemberResult(row, "patch", key !== null)) {
    captureTeamMemberError(
      new Error(
        "update_team_member_role_idempotent returned an invalid result",
      ),
      "update-result",
    );
    return unavailableOrInternal(key);
  }

  return resultResponse(row, key);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(() => removeMember(request, params));
}

async function removeMember(
  request: NextRequest,
  params: Params,
): Promise<Response> {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsedParams = await parseParams(params, TeamIdParamsSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const memberId = parsedParams.data.id.toLowerCase();

  const key = validateIdempotencyKey(request);
  if (key instanceof NextResponse) return key;

  const keyedArgs = key
    ? {
        p_idempotency_key: key,
        p_request_hash: createIdempotencyRequestHash({ id: memberId }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "remove_team_member_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_member_id: memberId,
      ...keyedArgs,
    },
  );

  if (error) {
    if (error.code === "42501") return Errors.forbidden("Forbidden.");
    captureTeamMemberError(error, "remove-rpc");
    if (key && error.code === "22023") {
      return Errors.badRequest(
        "Invalid team member removal request.",
        undefined,
        "invalid_team_member_removal_request",
      );
    }
    return unavailableOrInternal(key);
  }

  const row = firstResult(data);
  if (!isValidTeamMemberResult(row, "delete", key !== null)) {
    captureTeamMemberError(
      new Error("remove_team_member_idempotent returned an invalid result"),
      "remove-result",
    );
    return unavailableOrInternal(key);
  }

  return resultResponse(row, key);
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

function firstResult(data: unknown): TeamMemberMutationResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as TeamMemberMutationResult | null;
}

function resultResponse(
  row: TeamMemberMutationResult,
  key: string | null,
): Response {
  const headers: Record<string, string> = {};
  if (row.outcome === "idempotency_in_progress") {
    headers["Retry-After"] = "1";
  } else if (key && row.outcome === "replay") {
    headers["Idempotency-Replayed"] = "true";
  } else if (
    key &&
    ["updated", "removed", "not_found", "last_owner", "self_removal"].includes(
      row.outcome,
    )
  ) {
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

function isValidTeamMemberResult(
  row: TeamMemberMutationResult | null,
  operation: "patch" | "delete",
  isKeyed: boolean,
): row is TeamMemberMutationResult {
  const outcomes = operation === "patch" ? PATCH_OUTCOMES : DELETE_OUTCOMES;
  if (
    !row ||
    !outcomes.includes(row.outcome) ||
    typeof row.replayed !== "boolean" ||
    typeof row.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(row.execution_started_at)) ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    return false;
  }

  const statusForOutcome: Partial<
    Record<TeamMemberMutationResult["outcome"], number>
  > = {
    updated: 200,
    removed: 200,
    not_found: 404,
    last_owner: 400,
    self_removal: 400,
    idempotency_key_reused: 409,
    idempotency_key_expired: 409,
    idempotency_outcome_unknown: 409,
    idempotency_in_progress: 409,
  };
  if (
    row.outcome === "replay"
      ? ![200, 400, 404].includes(row.response_status)
      : statusForOutcome[row.outcome] !== row.response_status
  ) {
    return false;
  }
  if (
    !isKeyed &&
    ![
      "updated",
      "removed",
      "not_found",
      "last_owner",
      "self_removal",
    ].includes(row.outcome)
  ) {
    return false;
  }

  const body = record(row.response_body);
  if (row.response_status === 200) {
    return body?.success === true && Object.keys(body).length === 1;
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

  if (row.response_status === 404) {
    return error.code === "not_found" && error.message === "Member not found.";
  }
  if (row.response_status === 400) {
    const expectedMessage =
      operation === "patch"
        ? "Cannot demote the last owner."
        : "Cannot remove yourself.";
    return error.code === "bad_request" && error.message === expectedMessage;
  }

  const idempotencyMessages: Partial<
    Record<TeamMemberMutationResult["outcome"], string>
  > = {
    idempotency_key_reused:
      "This Idempotency-Key was already used for a different request.",
    idempotency_key_expired: "This Idempotency-Key has expired.",
    idempotency_outcome_unknown:
      "The original request outcome is unknown and will not be retried.",
    idempotency_in_progress:
      "A request with this Idempotency-Key is still in progress.",
  };
  const expectedMessage = idempotencyMessages[row.outcome];
  return (
    expectedMessage !== undefined &&
    error.code === row.outcome &&
    error.message === expectedMessage
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function captureTeamMemberError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "team-members", phase },
    });
  } catch {
    // Reporting cannot replace the fail-closed response.
  }
}
