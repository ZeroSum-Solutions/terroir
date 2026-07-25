/**
 * POST /api/scan-bottle/confirm -- creates an inventory_items row for a
 * confirmed bottle with section and bin location (BND-109).
 */
import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import { ConfirmBottleBodySchema } from "@/lib/scanner/request-schemas";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withApiHandler(() => postBottleConfirmation(request));
}

type ConfirmBottleResult = {
  outcome:
    | "confirmed"
    | "wine_not_found"
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

const CONFIRM_OUTCOMES: ConfirmBottleResult["outcome"][] = [
  "confirmed",
  "wine_not_found",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

async function postBottleConfirmation(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;

  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, ConfirmBottleBodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const {
    wine_id: parsedWineId,
    section,
    bin_location,
  } = parsed.data;
  const wineId = parsedWineId.toLowerCase();

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
          wine_id: wineId,
          section,
          bin_location,
        }),
      }
    : {};
  const { data, error } = await supabase.rpc(
    "confirm_bottle_scan_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_wine_id: wineId,
      p_section: section,
      p_bin_location: bin_location,
      ...keyedArgs,
    },
  );

  if (error) {
    if (error.code === "42501") return Errors.forbidden("Forbidden.");
    captureConfirmError(error, "rpc");
    if (rawKey && error.code === "22023") {
      return Errors.badRequest(
        "Invalid bottle confirmation request.",
        undefined,
        "invalid_bottle_confirmation_request",
      );
    }
    if (!rawKey) throw error;
    return apiError(
      503,
      "idempotency_unavailable",
      "Request idempotency is temporarily unavailable.",
    );
  }

  const row =
    Array.isArray(data) && data.length === 1
      ? (data[0] as ConfirmBottleResult)
      : null;
  if (
    !isValidConfirmResult(row, {
      keyed: rawKey !== null,
      wineId,
      section,
      binLocation: bin_location,
    })
  ) {
    const malformed = new Error(
      "confirm_bottle_scan_idempotent returned an invalid result",
    );
    captureConfirmError(malformed, "result");
    if (!rawKey) throw malformed;
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
    ["confirmed", "wine_not_found"].includes(row.outcome)
  ) {
    headers["Idempotency-Replayed"] = "false";
  }

  return apiResultResponse({
    status: row.response_status,
    body: row.response_body,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

function isValidConfirmResult(
  row: ConfirmBottleResult | null,
  expected: {
    keyed: boolean;
    wineId: string;
    section: string;
    binLocation: string;
  },
): row is ConfirmBottleResult {
  if (
    !row ||
    !CONFIRM_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    typeof row.replayed !== "boolean" ||
    typeof row.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(row.execution_started_at)) ||
    row.response_body === null ||
    row.response_body === undefined ||
    (row.outcome === "replay") !== row.replayed
  ) {
    return false;
  }

  if (
    !expected.keyed &&
    !["confirmed", "wine_not_found"].includes(row.outcome)
  ) {
    return false;
  }

  if (row.outcome === "confirmed" && row.response_status !== 201) {
    return false;
  }
  if (row.outcome === "wine_not_found" && row.response_status !== 404) {
    return false;
  }
  if (
    [
      "idempotency_key_reused",
      "idempotency_key_expired",
      "idempotency_outcome_unknown",
      "idempotency_in_progress",
    ].includes(row.outcome) &&
    row.response_status !== 409
  ) {
    return false;
  }
  if (
    row.outcome === "replay" &&
    ![201, 404].includes(row.response_status)
  ) {
    return false;
  }

  const body = record(row.response_body);
  if (row.response_status === 201) {
    return (
      body !== null &&
      typeof body.id === "string" &&
      body.wine_id === expected.wineId &&
      body.section === expected.section &&
      body.bin_location === expected.binLocation &&
      typeof body.added_at === "string" &&
      !Number.isNaN(Date.parse(body.added_at)) &&
      Object.keys(body).sort().join(",") ===
        "added_at,bin_location,id,section,wine_id"
    );
  }

  const error = record(body?.error);
  if (
    !body ||
    !error ||
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    Object.keys(body).length !== 1 ||
    Object.keys(error).length !== 2
  ) {
    return false;
  }
  if (row.response_status === 404) {
    return (
      error.code === "wine_not_found" &&
      error.message === "Wine not found or not in your restaurant."
    );
  }

  const idempotencyMessages: Partial<
    Record<ConfirmBottleResult["outcome"], string>
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

function captureConfirmError(error: unknown, phase: string): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "scan-bottle-confirm", phase },
    });
  } catch {
    // Reporting cannot replace the fail-closed response.
  }
}
