import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireCapability } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { CreateWineFromLwinBodySchema } from "@/lib/api/wine-provider-mutation-schemas";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireCapability("wine:manage");
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, CreateWineFromLwinBodySchema);
    if (!parsed.ok) return parsed.response;
    const {
      lwin_id,
    } = parsed.data;

    const { data: catalogWine, error: catalogError } = await supabase
      .from("lwin_catalog")
      .select("lwin_id, display_name, producer, varietal, region, country")
      .eq("lwin_id", lwin_id)
      .maybeSingle();
    if (catalogError) throw catalogError;
    if (!catalogWine) return Errors.notFound("LWIN wine");

    const { data: wineIds, error } = await supabase.rpc(
      "find_or_create_wines_batch",
      {
        p_restaurant_id: restaurantId,
        p_wines: [
          {
            name: catalogWine.display_name,
            producer: catalogWine.producer ?? "Unknown",
            vintage: null,
            varietal: catalogWine.varietal,
            region: catalogWine.region,
            country: catalogWine.country,
            size_ml: 750,
          },
        ],
      },
    );
    if (error) throw error;
    const parsedWineId = z.string().uuid().safeParse(wineIds?.[0]);
    if (!parsedWineId.success) {
      throw new Error("find-or-create wine RPC returned no valid ID");
    }
    const wineId = parsedWineId.data;

    const { data: updated, error: lwinError } = await supabase
      .from("wines")
      .update({ lwin_id: catalogWine.lwin_id })
      .eq("id", wineId)
      .eq("restaurant_id", restaurantId)
      .select("id")
      .maybeSingle();
    if (lwinError) throw lwinError;
    if (!updated) return Errors.notFound("Wine");

    return NextResponse.json({ id: wineId });
  });
}
