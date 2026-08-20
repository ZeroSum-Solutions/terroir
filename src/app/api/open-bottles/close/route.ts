import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { theoreticalRemaining } from "@/lib/partial-bottles/math";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

const BodySchema = z
  .strictObject({
    wine_id: z.string().uuid().optional(),
    open_bottle_id: z.string().uuid().optional(),
    actual_remaining_ml: z.number().int().nonnegative().max(2_147_483_647),
    written_off_ml: z.number().int().nonnegative().max(2_147_483_647).default(0),
    reason_code_id: z.string().uuid().optional(),
  })
  .refine((body) => Boolean(body.wine_id) !== Boolean(body.open_bottle_id), {
    message: "Provide exactly one of wine_id or open_bottle_id.",
  });

export async function POST(request: NextRequest) {
  return withApiHandler(() => postCloseout(request));
}

async function postCloseout(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(request, BodySchema, { message: "Invalid body." });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (body.written_off_ml > 0 && !body.reason_code_id) {
    return writeoffReasonRequired();
  }

  const bottle = await findBottle(auth.supabase, auth.restaurantId, body);
  if (!bottle) return Errors.notFound("Bottle");
  if (bottle.restaurant_id !== auth.restaurantId) return Errors.notFound("Bottle");
  if (
    body.actual_remaining_ml > bottle.wines.size_ml ||
    body.actual_remaining_ml + body.written_off_ml > bottle.wines.size_ml
  ) {
    return Errors.unprocessable(
      "invalid_closeout_amount",
      "Close-out amounts exceed the bottle contents.",
    );
  }

  if (body.reason_code_id) {
    const validReason = await findValidReason(
      auth.supabase,
      auth.restaurantId,
      body.reason_code_id,
    );
    if (!validReason) {
      return Errors.unprocessable(
        "invalid_writeoff_reason",
        "Reason code must be an active spoilage or adjustment reason.",
      );
    }
  }

  const theoretical = await calculateTheoretical(auth.supabase, bottle);
  return persistCloseout({
    bottle,
    theoretical,
    body,
    restaurantId: auth.restaurantId,
    userId: auth.user.id,
  });
}

type CloseBody = z.output<typeof BodySchema>;
type Bottle = {
  id: string;
  wine_id: string;
  restaurant_id: string;
  opened_at: string;
  preservation_method: string;
  remaining_ml: number;
  wines: { size_ml: number };
};

async function findBottle(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  body: CloseBody,
): Promise<Bottle | null> {
  let query = supabase
    .from("open_bottles")
    .select("id, wine_id, restaurant_id, opened_at, preservation_method, remaining_ml, closed_at, wines!inner(size_ml)")
    .eq("restaurant_id", restaurantId)
    .is("closed_at", null);
  query = body.open_bottle_id
    ? query.eq("id", body.open_bottle_id)
    : query.eq("wine_id", body.wine_id!);
  const { data, error } = await query
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as Bottle | null;
}

async function findValidReason(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  reasonId: string,
) {
  const { data, error } = await supabase
    .from("reason_codes")
    .select("id, restaurant_id, category, active")
    .eq("id", reasonId)
    .eq("restaurant_id", restaurantId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  return Boolean(
    data &&
      data.restaurant_id === restaurantId &&
      data.active &&
      ["spoilage", "adjustment"].includes(data.category),
  );
}

async function calculateTheoretical(
  supabase: SupabaseClient<Database>,
  bottle: Bottle,
) {
  const { data, error } = await supabase
    .from("pour_events")
    .select("ml_delta, kind")
    .eq("restaurant_id", bottle.restaurant_id)
    .eq("open_bottle_id", bottle.id)
    .gte("occurred_at", bottle.opened_at)
    .in("kind", ["pour", "spill"])
    .order("occurred_at", { ascending: true });
  if (error) throw error;
  return theoreticalRemaining(
    bottle.wines.size_ml,
    (data ?? []).map((event: { ml_delta: number }) => event.ml_delta),
  );
}

async function persistCloseout(input: {
  bottle: Bottle;
  theoretical: number;
  body: CloseBody;
  restaurantId: string;
  userId: string;
}) {
  const service = createServiceRoleClient();
  if (!service) return Errors.internal("Failed to close bottle.");
  try {
    return await writeCloseout(service, input);
  } catch {
    console.error("Unexpected service-role failure while closing bottle.");
    return Errors.internal("Failed to close bottle.");
  }
}

async function writeCloseout(
  service: SupabaseClient<Database>,
  input: {
    bottle: Bottle;
    theoretical: number;
    body: CloseBody;
    restaurantId: string;
    userId: string;
  },
) {
  const { bottle, theoretical, body, restaurantId, userId } = input;
  const { data, error } = await service
    .from("bottle_closeouts")
    .insert({
      restaurant_id: restaurantId,
      wine_id: bottle.wine_id,
      open_bottle_id: bottle.id,
      preservation_method: bottle.preservation_method,
      opened_at: bottle.opened_at,
      closed_by: userId,
      theoretical_remaining_ml: theoretical,
      actual_remaining_ml: body.actual_remaining_ml,
      written_off_ml: body.written_off_ml,
      reason_code_id: body.reason_code_id ?? null,
    })
    .select("id, open_bottle_id, wine_id, preservation_method, theoretical_remaining_ml, actual_remaining_ml, variance_ml, written_off_ml, reason_code_id, closed_at")
    .single();
  if (error) {
    if (isWriteoffCheck(error)) return writeoffReasonRequired();
    console.error("Failed to persist bottle close-out.");
    return Errors.internal("Failed to close bottle.");
  }

  const finishError = await finishBottle(service, bottle, restaurantId, userId);
  if (finishError) {
    console.error("Failed to finish bottle after close-out.");
    const rollbackError = await rollbackCloseout(service, data.id, restaurantId);
    if (rollbackError) {
      console.error("Failed to roll back close-out after finish failure.");
    }
    return Errors.internal("Failed to close bottle.");
  }

  revalidatePath("/cellar");
  revalidatePath("/insights");
  return NextResponse.json({ closeout: data }, { status: 201 });
}

async function finishBottle(
  service: SupabaseClient<Database>,
  bottle: Bottle,
  restaurantId: string,
  userId: string,
) {
  const { error } = await service.from("pour_events").insert({
    wine_id: bottle.wine_id,
    restaurant_id: restaurantId,
    open_bottle_id: bottle.id,
    ml_delta: bottle.remaining_ml,
    kind: "finish_bottle",
    actor_user_id: userId,
    note: "Bottle close-out",
  });
  return error;
}

async function rollbackCloseout(
  service: SupabaseClient<Database>,
  closeoutId: string,
  restaurantId: string,
) {
  const { error } = await service
    .from("bottle_closeouts")
    .delete()
    .eq("id", closeoutId)
    .eq("restaurant_id", restaurantId);
  return error;
}

function isWriteoffCheck(error: { code?: string; message?: string }) {
  return error.code === "23514" &&
    String(error.message ?? "").includes("writeoff_requires_reason");
}

function writeoffReasonRequired() {
  return Errors.unprocessable(
    "writeoff_reason_required",
    "A reason code is required for a write-off.",
  );
}
