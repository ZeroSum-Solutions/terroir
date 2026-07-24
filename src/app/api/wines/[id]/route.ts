import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  EditWineBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";

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
      if (!current) return Errors.notFound("Wine");

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
        return Errors.unprocessable(
          "invalid_drink_window",
          "Drink-window start must not be after its end.",
        );
      }
      if (
        peak !== null &&
        ((start !== null && peak < start) || (end !== null && peak > end))
      ) {
        return Errors.unprocessable(
          "invalid_drink_window",
          "Peak year must fall within the drink window.",
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
      return Errors.conflict(
        "wine_collision",
        "A matching wine already exists.",
      );
    }
    if (error) throw error;
    if (!data) return Errors.notFound("Wine");

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

    return NextResponse.json(data);
  });
}
