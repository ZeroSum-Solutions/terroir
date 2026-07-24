import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireAuth } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { rateLimit } from "@/lib/api/rate-limit";
import { apiResultResponse } from "@/lib/api/result-response";
import { AcceptInviteBodySchema } from "@/lib/api/team-schemas";
import { parseJson } from "@/lib/api/validation";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

const ACCEPT_INVITE_LIMIT = 10;
const ACCEPT_INVITE_WINDOW_MS = 60 * 60 * 1000;

type AcceptInviteResult = {
  outcome:
    | "accepted"
    | "replay"
    | "not_found"
    | "already_used"
    | "invitation_expired"
    | "idempotency_key_reused"
    | "idempotency_key_expired"
    | "idempotency_outcome_unknown"
    | "idempotency_in_progress";
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: NextRequest) {
  return withApiHandler(() => acceptInvitation(request));
}

async function acceptInvitation(request: NextRequest) {
  const auth = await requireAuth({ rateLimit: "sensitive" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, user } = auth;

  const limit = rateLimit(
    `accept-invite:${clientIp(request)}:${user.id}`,
    ACCEPT_INVITE_LIMIT,
    ACCEPT_INVITE_WINDOW_MS,
  );
  if (!limit.ok) {
    return Errors.rateLimited(
      "Too many invitation attempts. Try again later.",
      { headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = await parseJson(request, AcceptInviteBodySchema);
  if (!parsed.ok) return parsed.response;

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
          token: parsed.data.token,
        }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "accept_invitation_idempotent",
    {
      p_token: parsed.data.token,
      ...keyedArgs,
    },
  );

  if (error) {
    if (!rawKey) throw error;
    captureAcceptInviteError(error, "idempotent-rpc");
    return apiError(
      503,
      "idempotency_unavailable",
      "Request idempotency is temporarily unavailable.",
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | AcceptInviteResult
    | null;
  if (
    !row ||
    ![
      "accepted",
      "replay",
      "not_found",
      "already_used",
      "invitation_expired",
      "idempotency_key_reused",
      "idempotency_key_expired",
      "idempotency_outcome_unknown",
      "idempotency_in_progress",
    ].includes(String(row.outcome)) ||
    !Number.isInteger(row.response_status) ||
    row.response_status < 100 ||
    row.response_status > 599 ||
    typeof row.replayed !== "boolean" ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    const malformed = new Error(
      "accept_invitation_idempotent returned an invalid result",
    );
    if (!rawKey) throw malformed;
    captureAcceptInviteError(malformed, "idempotent-rpc-result");
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
    ["accepted", "already_used", "invitation_expired"].includes(row.outcome)
  ) {
    headers["Idempotency-Replayed"] = "false";
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function captureAcceptInviteError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "accept-invite", phase },
    });
  } catch {
    // Error reporting cannot replace the fail-closed response.
  }
}
