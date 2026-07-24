import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseParams } from "@/lib/api/validation";
import { WineIdParamsSchema } from "@/lib/api/wine-mutation-schemas";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsedParams = await parseParams(params, WineIdParamsSchema);
    if (!parsedParams.ok) return parsedParams.response;
    const { id } = parsedParams.data;

    const { data: wine, error: fetchError } = await supabase
      .from("wines")
      .select("id, overpaid_flag")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!wine) return Errors.notFound("Wine");

    const overpaidFlag = !wine.overpaid_flag;
    const { data: updated, error } = await supabase
      .from("wines")
      .update({ overpaid_flag: overpaidFlag })
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) return Errors.notFound("Wine");

    return NextResponse.json({ wineId: id, overpaid_flag: overpaidFlag });
  });
}
