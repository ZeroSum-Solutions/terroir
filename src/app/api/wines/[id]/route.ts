import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  EditWineBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function isInvalidDrinkWindow(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "22023" &&
    "message" in error &&
    typeof error.message === "string" &&
    (error.message.includes("drink-window") ||
      error.message.includes("peak year"))
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, EditWineBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;
    const updates = parsedBody.data;

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/wines/{param}",
      payload: { id, updates },
      releaseOnError: false,
      handler: () => updateWineResponse({ supabase, restaurantId, id, updates }),
    });
  });
}

async function updateWineResponse({
  supabase,
  restaurantId,
  id,
  updates,
}: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  id: string;
  updates: z.infer<typeof EditWineBodySchema>;
}) {
  // TER-026 / TER-CF-095 + TER-CF-101: the metadata write and the
  // corresponding manual-field locks must commit in one transaction. A
  // previous two-statement flow could persist the manual value and then
  // fail before recording its override, allowing enrichment to overwrite it.
  const { data: rows, error } = await supabase.rpc(
    "update_wine_metadata_atomic",
    {
      p_restaurant_id: restaurantId,
      p_wine_id: id,
      p_updates: updates,
    },
  );
  if (isUniqueViolation(error)) {
    return errorResult(
      "wine_collision",
      "A matching wine already exists.",
      409,
    );
  }
  if (isInvalidDrinkWindow(error)) {
    const message = (error as { message: string }).message;
    return errorResult(
      "invalid_drink_window",
      message.includes("peak year")
        ? "Peak year must fall within the drink window."
        : "Drink-window start must not be after its end.",
      422,
    );
  }
  if (error) throw error;
  const data = rows?.[0] ?? null;
  if (!data) return errorResult("not_found", "Wine not found.", 404);

  return { status: 200, body: data };
}

function errorResult(code: string, message: string, status: number) {
  return { status, body: { error: { code, message } } };
}
