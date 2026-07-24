import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import {
  createIdempotencyRequestHash,
  isValidIdempotencyKey,
  withIdempotency,
} from "@/lib/api/idempotency";
import { apiResultResponse } from "@/lib/api/result-response";
import { parseJson } from "@/lib/api/validation";
import type { Database } from "@/types/database";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
});

type OpenBottleRow = {
  outcome: "opened" | "not_found" | "no_sealed_stock";
  bottle_id: string | null;
  wine_id: string | null;
  remaining_ml: number | null;
  opened_at: string | null;
};

/**
 * POST /api/open-bottles
 *
 * Atomically decrements one sealed inventory unit and opens or replaces the
 * active bottle without recording a pour event. Any member (staff+) may use
 * the command. A supplied Idempotency-Key binds the logical wine-open action
 * and prevents a lost response from consuming another sealed bottle.
 */
export async function POST(request: NextRequest) {
  return withApiHandler(() => postOpenBottle(request));
}

async function postOpenBottle(request: NextRequest) {
  const auth = await requireMembership({ rateLimit: "mutation" });
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseJson(request, BodySchema, {
    message: "Invalid body.",
  });
  if (!parsed.ok) return parsed.response;
  const { wine_id } = parsed.data;

  const rawKey = request.headers.get("Idempotency-Key");
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return Errors.badRequest(
      "Invalid Idempotency-Key.",
      undefined,
      "invalid_idempotency_key",
    );
  }

  const result = await withIdempotency({
    supabase,
    restaurantId,
    operationId: "api:POST:/api/open-bottles",
    key: rawKey,
    requestHash: createIdempotencyRequestHash({ wine_id }),
    handler: () =>
      openBottleOnce({
        supabase,
        restaurantId,
        wineId: wine_id,
      }),
  });

  if (result.status === 201) {
    try {
      revalidatePath("/cellar/open");
    } catch (error) {
      try {
        Sentry.captureException(error, {
          tags: { surface: "open-bottles", phase: "revalidate" },
        });
      } catch {
        // Cache invalidation reporting cannot replace a committed response.
      }
    }
  }

  return apiResultResponse(result);
}

async function openBottleOnce(options: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  wineId: string;
}): Promise<{ status: number; body: unknown }> {
  const { data, error } = await options.supabase.rpc(
    "open_bottle_from_inventory",
    {
      p_restaurant_id: options.restaurantId,
      p_wine_id: options.wineId,
    },
  );
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as
    | OpenBottleRow
    | null;
  if (!row) {
    throw new Error("open_bottle_from_inventory returned no result");
  }

  if (row.outcome === "not_found") {
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: "Wine not found." },
      },
    };
  }
  if (row.outcome === "no_sealed_stock") {
    return {
      status: 409,
      body: {
        error: {
          code: "no_sealed_stock",
          message: "No sealed bottles available to open.",
        },
      },
    };
  }
  if (
    row.outcome !== "opened" ||
    typeof row.bottle_id !== "string" ||
    typeof row.wine_id !== "string" ||
    !Number.isInteger(row.remaining_ml) ||
    typeof row.opened_at !== "string"
  ) {
    throw new Error("open_bottle_from_inventory returned an invalid result");
  }

  return {
    status: 201,
    body: {
      open_bottle: {
        id: row.bottle_id,
        wine_id: row.wine_id,
        remaining_ml: row.remaining_ml,
        opened_at: row.opened_at,
      },
    },
  };
}
