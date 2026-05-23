import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { revalidateAutoEightysixedWines } from "@/lib/api/auto-eightysix-revalidation";
import { Errors } from "@/lib/api/errors";

export const runtime = "nodejs";

const BodySchema = z.object({
  wine_id: z.string().uuid(),
  ml: z.number().int().positive().max(2000),
  kind: z.enum(["pour", "spill"]).default("pour"),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/pour
 *
 * BND-038. Records a pour (or spill) against the wine's open bottle.
 * Calls record_pour RPC (atomic: opens a new bottle if needed; handles
 * overage across bottles). Role-gated inside the RPC to
 * owner | manager | staff.
 *
 * 200: { open_bottle: { wine_id, remaining_ml, opened_at, ... } }
 * 400: invalid body
 * 401: unauthenticated (from requireMembership)
 * 403: caller not a member of this wine's restaurant (from RPC)
 * 409: NO_INVENTORY — no sealed bottles to open (from RPC)
 * 500: any other RPC error (also reported to Sentry)
 */
export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Errors.validation(parsed.error.issues, "Invalid body.");
  }
  const { wine_id, ml, kind, note } = parsed.data;

  // ARCH-023: capture timestamp BEFORE the write so we can detect
  // an auto-86 event inserted by the pour_events trigger. The
  // revalidation after the write queries availability_events for
  // rows newer than this.
  const sinceTs = new Date().toISOString();

  // The generator emits p_kind/p_note as `string` (not `string | null`)
  // because SQL DEFAULTs don't translate to TS nullability. Cast for
  // runtime; Postgres accepts NULL. Same pattern as the availability PATCH.
  const { data, error } = await supabase.rpc("record_pour", {
    p_wine_id: wine_id,
    p_ml: ml,
    p_kind: kind,
    p_note: (note ?? null) as unknown as string,
  });

  if (error) {
    if (
      error.code === "P0001" &&
      String(error.message ?? "").includes("TERROIR_OUT_OF_STOCK")
    ) {
      return Errors.conflict("no_inventory", "No inventory available.");
    }
    if (error.code === "42501") {
      return Errors.forbidden("Forbidden.");
    }
    console.error("record_pour failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "pour", phase: "record_pour-rpc" },
      extra: { wine_id, ml, kind },
    });
    return Errors.internal("Pour failed.");
  }

  // Revalidate /availability so the 86 UI sees fresh state.
  revalidatePath("/availability");

  // ARCH-023: if the pour trigger auto-86'd this wine, revalidate
  // every published /list/[slug] that references it. Best-effort.
  await revalidateAutoEightysixedWines({
    supabase,
    restaurantId,
    touchedWineIds: [wine_id],
    sinceTs,
  });

  return NextResponse.json({ open_bottle: data });
}
