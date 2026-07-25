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
import { parseParams } from "@/lib/api/validation";
import { ScanIdParamsSchema } from "@/lib/scanner/request-schemas";
import type { Json } from "@/types/database";

export const runtime = "nodejs";

type CommitOutcome =
  | "committed"
  | "not_found"
  | "invalid_scan"
  | "replay"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type CommitResult = {
  outcome: CommitOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
  wine_ids: string[] | null;
};

const COMMIT_OUTCOMES: readonly CommitOutcome[] = [
  "committed",
  "not_found",
  "invalid_scan",
  "replay",
  "idempotency_key_reused",
  "idempotency_key_expired",
  "idempotency_outcome_unknown",
  "idempotency_in_progress",
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireMembership({ rateLimit: "mutation" });
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, ScanIdParamsSchema);
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
      "commit_invoice_scan_idempotent",
      {
        p_restaurant_id: restaurantId,
        p_scan_id: id,
        ...keyedArgs,
      },
    );

    if (error) {
      if (error.code === "42501") return Errors.forbidden("Forbidden.");
      captureCommitError(error, "commit-rpc", { scanId: id });
      if (rawKey && error.code === "22023") {
        return Errors.badRequest(
          "Invalid scan commit request.",
          undefined,
          "invalid_scan_commit_request",
        );
      }
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    const row = firstResult(data);
    if (!isCommitResult(row, rawKey !== null, id)) {
      captureCommitError(
        new Error(
          "commit_invoice_scan_idempotent returned an invalid result",
        ),
        "commit-result",
        { scanId: id },
      );
      return rawKey
        ? apiError(
            503,
            "idempotency_unavailable",
            "Request idempotency is temporarily unavailable.",
          )
        : Errors.internal();
    }

    if (row.outcome === "committed" && row.wine_ids) {
      matchLwinBestEffort(supabase, restaurantId, row.wine_ids, id);
    }

    const headers: Record<string, string> = {};
    if (row.outcome === "idempotency_in_progress") {
      headers["Retry-After"] = "1";
    } else if (rawKey && row.outcome === "replay") {
      headers["Idempotency-Replayed"] = "true";
    } else if (
      rawKey &&
      ["committed", "not_found", "invalid_scan"].includes(row.outcome)
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

function firstResult(data: unknown): CommitResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as CommitResult | null;
}

function isCommitResult(
  row: CommitResult | null,
  isKeyed: boolean,
  scanId: string,
): row is CommitResult {
  if (
    !row ||
    !COMMIT_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    typeof row.replayed !== "boolean" ||
    (row.outcome === "replay") !== row.replayed ||
    !isRecord(row.response_body) ||
    (
      row.wine_ids !== null &&
      (
        !Array.isArray(row.wine_ids) ||
        row.wine_ids.some((id) => !isUuid(id))
      )
    )
  ) {
    return false;
  }

  if (!isKeyed && row.outcome.startsWith("idempotency_")) return false;
  if (row.outcome === "committed") {
    return (
      row.response_status === 200 &&
      row.wine_ids !== null &&
      isCommitBody(row.response_body, scanId, row.wine_ids.length)
    );
  }
  if (row.outcome === "replay") {
    return (
      row.wine_ids === null &&
      (
        (
          row.response_status === 200 &&
          isCommitBody(row.response_body, scanId)
        ) ||
        (
          row.response_status === 404 &&
          isErrorBody(row.response_body, "not_found")
        ) ||
        (
          row.response_status === 400 &&
          isErrorBody(row.response_body, "bad_request")
        )
      )
    );
  }

  const expected: Record<
    Exclude<CommitOutcome, "committed" | "replay">,
    [number, string]
  > = {
    not_found: [404, "not_found"],
    invalid_scan: [400, "bad_request"],
    idempotency_key_reused: [409, "idempotency_key_reused"],
    idempotency_key_expired: [409, "idempotency_key_expired"],
    idempotency_outcome_unknown: [409, "idempotency_outcome_unknown"],
    idempotency_in_progress: [409, "idempotency_in_progress"],
  };
  const [status, code] = expected[row.outcome];
  return (
    row.response_status === status &&
    row.wine_ids === null &&
    isErrorBody(row.response_body, code)
  );
}

function isCommitBody(
  body: Record<string, unknown>,
  scanId: string,
  wineIdCount?: number,
): boolean {
  return (
    body.scanId === scanId &&
    Number.isInteger(body.itemCount) &&
    (body.itemCount as number) > 0 &&
    Number.isInteger(body.wineCount) &&
    (body.wineCount as number) > 0 &&
    (wineIdCount === undefined || body.itemCount === wineIdCount)
  );
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

function matchLwinBestEffort(
  supabase: {
    rpc: (
      name: "match_lwin_batch",
      args: { p_restaurant_id: string; p_wine_ids: string[] },
    ) => PromiseLike<{ error: unknown }>;
  },
  restaurantId: string,
  wineIds: string[],
  scanId: string,
): void {
  try {
    void Promise.resolve(
      supabase.rpc("match_lwin_batch", {
        p_restaurant_id: restaurantId,
        p_wine_ids: wineIds,
      }),
    )
      .then(({ error }) => {
        if (error) {
          captureCommitError(error, "lwin-match", { scanId });
        }
      })
      .catch((error) => {
        captureCommitError(error, "lwin-match", { scanId });
      });
  } catch (error) {
    captureCommitError(error, "lwin-match", { scanId });
  }
}

function captureCommitError(
  error: unknown,
  phase: string,
  extra?: Record<string, unknown>,
): void {
  try {
    Sentry.captureException(error, {
      tags: { surface: "scan-commit", phase },
      ...(extra ? { extra } : {}),
    });
  } catch {
    // Observability is best effort and never changes a committed response.
  }
}
