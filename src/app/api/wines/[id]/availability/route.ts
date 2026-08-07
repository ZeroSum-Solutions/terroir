import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { idempotentMutationResponse } from "@/lib/api/idempotent-mutation";
import { parseJson, parseParams } from "@/lib/api/validation";
import {
  WineAvailabilityBodySchema,
  WineIdParamsSchema,
} from "@/lib/api/wine-mutation-schemas";
import type { Database } from "@/types/database";

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

    return idempotentMutationResponse<unknown>({
      request,
      supabase,
      restaurantId,
      operationId: "api:PATCH:/api/wines/{param}/availability",
      payload: { id, direction, note: note ?? null },
      releaseOnError: false,
      handler: () => availabilityResponse({
        supabase,
        restaurantId,
        id,
        direction,
        note,
      }),
    });
  });
}

async function availabilityResponse({
  supabase,
  restaurantId,
  id,
  direction,
  note,
}: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  id: string;
  direction: "eightysixed" | "restored";
  note?: string;
}) {

    const { data: scope, error: scopeError } = await supabase
      .from("wines")
      .select("id")
      .eq("id", id)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (scopeError) throw scopeError;
    if (!scope) return errorResult("not_found", "Wine not found.", 404);

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
      return { status: 200, body: { changed: false } };
    }

    const event = events[0];
    return {
      status: 200,
      body: {
        changed: true,
        event: {
          direction: event.direction,
          occurred_at: event.created_at,
        },
      },
    };
}

function errorResult(code: string, message: string, status: number) {
  return { status, body: { error: { code, message } } };
}
