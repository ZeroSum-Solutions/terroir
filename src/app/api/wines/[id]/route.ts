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

    const enrichableFieldMap: Record<string, string> = {
      region: "region",
      varietal: "varietal",
      drink_window_start: "drink_window",
      drink_window_end: "drink_window",
      peak_year: "drink_window",
    };
    const overriddenFields = new Set<string>();
    for (const key of Object.keys(updates)) {
      const mapped = enrichableFieldMap[key];
      if (mapped) overriddenFields.add(mapped);
    }

    if (overriddenFields.has("drink_window")) {
      const { data: current, error: currentError } = await supabase
        .from("wines")
        .select("drink_window_start, drink_window_end, peak_year")
        .eq("id", id)
        .eq("restaurant_id", restaurantId)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) return errorResult("not_found", "Wine not found.", 404);

      const start =
        updates.drink_window_start !== undefined
          ? updates.drink_window_start
          : current.drink_window_start;
      const end =
        updates.drink_window_end !== undefined
          ? updates.drink_window_end
          : current.drink_window_end;
      const peak =
        updates.peak_year !== undefined
          ? updates.peak_year
          : current.peak_year;
      if (start !== null && end !== null && start > end) {
        return errorResult(
          "invalid_drink_window",
          "Drink-window start must not be after its end.",
          422,
        );
      }
      if (
        peak !== null &&
        ((start !== null && peak < start) || (end !== null && peak > end))
      ) {
        return errorResult(
          "invalid_drink_window",
          "Peak year must fall within the drink window.",
          422,
        );
      }
    }

    const { data, error } = await supabase
      .from("wines")
      .update(updates)
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select(
        "id, producer, name, vintage, varietal, region, tasting_notes, drink_window_start, drink_window_end, peak_year, updated_at",
      )
      .maybeSingle();
    if (isUniqueViolation(error)) {
      return errorResult(
        "wine_collision",
        "A matching wine already exists.",
        409,
      );
    }
    if (error) throw error;
    if (!data) return errorResult("not_found", "Wine not found.", 404);

    if (overriddenFields.size > 0) {
      const { error: overrideError } = await supabase.rpc(
        "add_manual_overrides",
        {
          p_wine_id: id,
          p_fields: [...overriddenFields],
        },
      );
      if (overrideError) {
        throw overrideError;
      }
    }

    return { status: 200, body: data };
}

function errorResult(code: string, message: string, status: number) {
  return { status, body: { error: { code, message } } };
}
