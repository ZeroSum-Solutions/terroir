import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  WineAvailabilityBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

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
    const parsedBody = await parseJson(request, WineAvailabilityBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { id } = parsedParams.data;
    const { direction, note } = parsedBody.data;

    const { data: scope, error: scopeError } = await supabase
      .from("wines")
      .select("id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (scopeError) throw scopeError;
    if (!scope) return Errors.notFound("Wine");

    const { data: events, error: rpcError } = await supabase.rpc(
      "set_wine_availability",
      {
        p_wine_id: id,
        p_direction: direction,
        p_note: (note ?? null) as unknown as string,
      },
    );
    if (rpcError) throw rpcError;

    const { data: affected, error: affectedError } = await supabase.rpc(
      "wine_published_list_slugs",
      { p_wine_id: id, p_restaurant_id: restaurantId },
    );
    if (affectedError) throw affectedError;
    for (const row of (affected ?? []) as Array<{ slug: string }>) {
      revalidatePath(`/list/${row.slug}`);
    }

    if (!events || events.length === 0) {
      return NextResponse.json({ changed: false });
    }

    const event = events[0];
    return NextResponse.json({
      changed: true,
      event: {
        direction: event.direction,
        occurred_at: event.created_at,
      },
    });
  });
}
