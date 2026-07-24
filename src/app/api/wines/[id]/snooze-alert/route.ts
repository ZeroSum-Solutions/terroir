import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  AlertDaysBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const parsedBody = await parseJson(request, AlertDaysBodySchema, {
      allowEmpty: true,
    });
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;
    const days = parsedBody.data.days ?? 30;

    const { data: wine, error: fetchError } = await supabase
      .from("wines")
      .select("id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!wine) return Errors.notFound("Wine");

    if (days === 0) {
      const { data: cleared, error } = await supabase
        .from("wines")
        .update({ alert_snoozed_until: null })
        .eq("id", id)
        .eq("restaurant_id", restaurantId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!cleared) return Errors.notFound("Wine");
      return NextResponse.json({
        wineId: id,
        snoozedUntil: null,
        days,
      });
    }

    const { data: until, error } = await supabase.rpc(
      "snooze_drink_window_alert",
      { p_wine_id: id, p_days: days },
    );
    if (error) throw error;
    if (!until) throw new Error("snooze alert RPC returned no timestamp");

    return NextResponse.json({
      wineId: id,
      snoozedUntil: until,
      days,
    });
  });
}
