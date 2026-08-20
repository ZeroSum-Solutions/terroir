import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

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
    return apiError(
      422,
      "writeoff_reason_required",
      "A reason code is required for a write-off.",
    );
  }

  let wineId = body.wine_id;
  if (!wineId) {
    const { data: bottle, error: bottleError } = await auth.supabase
      .from("open_bottles")
      .select("wine_id")
      .eq("id", body.open_bottle_id!)
      .eq("restaurant_id", auth.restaurantId)
      .is("closed_at", null)
      .maybeSingle();
    if (bottleError) throw bottleError;
    if (!bottle) {
      return apiError(404, "open_bottle_not_found", "Open bottle not found.");
    }
    wineId = bottle.wine_id;
  }

  const { data, error } = await auth.supabase.rpc("close_open_bottle", {
    p_wine_id: wineId,
    p_actual_remaining_ml: body.actual_remaining_ml,
    p_written_off_ml: body.written_off_ml,
    p_reason_code_id: body.reason_code_id ?? undefined,
  });
  if (error) {
    const response = rpcErrorResponse(error.message);
    if (response) return response;
    console.error("Failed to close bottle through close_open_bottle RPC.");
    return Errors.internal("Failed to close bottle.");
  }

  revalidatePath("/cellar");
  revalidatePath("/insights");
  return NextResponse.json({ closeout: data }, { status: 201 });
}

function rpcErrorResponse(message: string) {
  switch (message.trim()) {
    case "wine_not_found":
      return apiError(404, "wine_not_found", "Wine not found.");
    case "open_bottle_not_found":
      return apiError(404, "open_bottle_not_found", "Open bottle not found.");
    case "forbidden":
      return apiError(403, "forbidden", "Forbidden");
    case "wine_size_unknown":
      return apiError(422, "wine_size_unknown", "Wine bottle size is unknown.");
    case "invalid_actual_remaining":
      return apiError(
        422,
        "invalid_actual_remaining",
        "Actual remaining volume is outside the bottle's capacity.",
      );
    case "invalid_writeoff_amount":
      return apiError(
        422,
        "invalid_writeoff_amount",
        "Write-off must not exceed the actual remaining volume.",
      );
    case "writeoff_reason_required":
      return apiError(
        422,
        "writeoff_reason_required",
        "A reason code is required for a write-off.",
      );
    case "invalid_reason_code":
      return apiError(
        422,
        "invalid_reason_code",
        "Reason code must be an active spoilage or adjustment reason.",
      );
    default:
      return null;
  }
}
