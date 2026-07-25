import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  normalizeWineListSlug,
  PublishWineListBodySchema,
  WineListIdParamsSchema,
} from "@/lib/api/wine-list-lifecycle-schemas";
import type { Database, Json } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

type PublicationOutcome =
  | "published"
  | "unpublished"
  | "not_found"
  | "slug_collision"
  | "replay"
  | "idempotency_key_reused"
  | "idempotency_key_expired"
  | "idempotency_outcome_unknown"
  | "idempotency_in_progress";

type PublicationResult = {
  outcome: PublicationOutcome;
  response_status: number;
  response_body: Json;
  replayed: boolean;
};

type PublicationInput = {
  request: NextRequest;
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  id: string;
  publish: boolean;
  slug?: string;
};

const PUBLICATION_OUTCOMES: readonly PublicationOutcome[] = [
  "published",
  "unpublished",
  "not_found",
  "slug_collision",
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

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, PublishWineListBodySchema, {
      allowEmpty: true,
    });
    if (!parsedBody.ok) return parsedBody.response;

    let slug: string | undefined;
    if (parsedBody.data.slug !== undefined) {
      const customSlug = normalizeWineListSlug(parsedBody.data.slug);
      if (!customSlug.ok) {
        return Errors.unprocessable("invalid_slug", customSlug.message);
      }
      slug = customSlug.value;
    }

    return publicationResponse({
      request,
      supabase: auth.supabase,
      restaurantId: auth.restaurantId,
      id: parsedParams.data.id.toLowerCase(),
      publish: true,
      ...(slug === undefined ? {} : { slug }),
    });
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;

    const parsedParams = await parseParams(params, WineListIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;

    return publicationResponse({
      request,
      supabase: auth.supabase,
      restaurantId: auth.restaurantId,
      id: parsedParams.data.id.toLowerCase(),
      publish: false,
    });
  });
}

async function publicationResponse(input: PublicationInput) {
  const rawKey = input.request.headers.get("Idempotency-Key");
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return Errors.badRequest(
      "Invalid Idempotency-Key.",
      undefined,
      "invalid_idempotency_key",
    );
  }

  const payload = input.publish
    ? {
        id: input.id,
        body: input.slug === undefined ? {} : { slug: input.slug },
      }
    : { id: input.id };
  const keyedArgs = rawKey
    ? {
        p_idempotency_key: rawKey,
        p_request_hash: createIdempotencyRequestHash(payload),
      }
    : {};
  const { data, error } = await input.supabase.rpc(
    "set_wine_list_publication_idempotent",
    {
      p_restaurant_id: input.restaurantId,
      p_wine_list_id: input.id,
      p_publish: input.publish,
      p_has_slug: input.slug !== undefined,
      ...(input.slug === undefined ? {} : { p_slug: input.slug }),
      ...keyedArgs,
    },
  );

  if (error) {
    if (error.code === "42501") return Errors.forbidden("Forbidden.");
    if (rawKey && error.code === "22023") {
      return Errors.badRequest(
        "Invalid wine-list publication request.",
        undefined,
        "invalid_wine_list_publication_request",
      );
    }
    capturePublicationError(
      error,
      "publication-rpc",
      input.id,
      input.publish,
    );
    return rawKey
      ? apiError(
          503,
          "idempotency_unavailable",
          "Request idempotency is temporarily unavailable.",
        )
      : Errors.internal();
  }

  const row = firstResult(data);
  if (!isPublicationResult(row, rawKey !== null, input.publish)) {
    capturePublicationError(
      new Error(
        "set_wine_list_publication_idempotent returned an invalid result",
      ),
      "publication-result",
      input.id,
      input.publish,
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
}

function firstResult(data: unknown): PublicationResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return data[0] as PublicationResult | null;
}

function isPublicationResult(
  row: PublicationResult | null,
  isKeyed: boolean,
  publish: boolean,
): row is PublicationResult {
  if (
    !row ||
    !PUBLICATION_OUTCOMES.includes(row.outcome) ||
    !Number.isInteger(row.response_status) ||
    typeof row.replayed !== "boolean" ||
    (row.outcome === "replay") !== row.replayed ||
    !isRecord(row.response_body) ||
    (!isKeyed && row.outcome.startsWith("idempotency_")) ||
    (!isKeyed && row.outcome === "replay")
  ) {
    return false;
  }

  if (row.outcome === "published") {
    return (
      publish &&
      row.response_status === 200 &&
      isValidSlug(row.response_body.slug)
    );
  }
  if (row.outcome === "unpublished") {
    return (
      !publish &&
      row.response_status === 200 &&
      row.response_body.ok === true
    );
  }
  if (row.outcome === "replay") {
    return (
      (publish &&
        row.response_status === 200 &&
        isValidSlug(row.response_body.slug)) ||
      (!publish &&
        row.response_status === 200 &&
        row.response_body.ok === true) ||
      (row.response_status === 404 &&
        isErrorBody(row.response_body, "not_found")) ||
      (publish &&
        row.response_status === 409 &&
        isErrorBody(row.response_body, "slug_collision"))
    );
  }

  const expected: Record<
    Exclude<PublicationOutcome, "published" | "unpublished" | "replay">,
    [number, string]
  > = {
    not_found: [404, "not_found"],
    slug_collision: [409, "slug_collision"],
    idempotency_key_reused: [409, "idempotency_key_reused"],
    idempotency_key_expired: [409, "idempotency_key_expired"],
    idempotency_outcome_unknown: [409, "idempotency_outcome_unknown"],
    idempotency_in_progress: [409, "idempotency_in_progress"],
  };
  const [status, code] = expected[row.outcome];
  return (
    row.response_status === status &&
    isErrorBody(row.response_body, code) &&
    (row.outcome !== "slug_collision" || publish)
  );
}

function idempotencyHeaders(
  row: PublicationResult,
  isKeyed: boolean,
): Record<string, string> | null {
  if (row.outcome === "idempotency_in_progress") {
    return { "Retry-After": "1" };
  }
  if (!isKeyed) return null;
  if (row.outcome === "replay") {
    return { "Idempotency-Replayed": "true" };
  }
  if (
    ["published", "unpublished", "not_found", "slug_collision"].includes(
      row.outcome,
    )
  ) {
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

function isValidSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 50 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

function capturePublicationError(
  error: unknown,
  phase: string,
  listId: string,
  publish: boolean,
): void {
  try {
    Sentry.captureException(error, {
      tags: {
        surface: "wine-list-publication",
        phase,
        action: publish ? "publish" : "unpublish",
      },
      extra: { listId },
    });
  } catch {
    // Error reporting cannot replace the fail-closed response.
  }
}
