import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireAuth, requireOwner } from "@/lib/api/auth";
import { setActiveRestaurant } from "@/lib/api/active-restaurant";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * PUT /api/restaurant/[id] — switch the caller's active restaurant to :id.
 * The membership check happens inside setActiveRestaurant; users who aren't
 * members of :id get a 403 and no cookie change.
 */
export async function PUT(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, user } = auth;

  const result = await setActiveRestaurant(supabase, user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 403 });
  }
  return NextResponse.json({ ok: true, restaurantId: id });
}

// BND-037b + BND-040: PATCH accepts auto-86 columns AND pricing target
// columns. Each field is independently optional — partial updates work.
// Zod.strict() rejects unknown keys so the shape is defensible.
const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    auto_eightysix_from_inventory: z.boolean().optional(),
    // Upper bound is a sanity cap — no legitimate threshold exceeds
    // a magnum (1500 ml). The DB also has a check (>= 0).
    eightysix_ml_threshold: z.number().int().min(0).max(5000).optional(),
    // BND-040 — pricing intelligence house targets. Mirror DB CHECK
    // constraints (0-100 for pour cost %, 1-10 for markup ratio).
    default_target_pour_cost_pct: z.number().gt(0).lt(100).optional(),
    default_target_markup_ratio: z.number().gte(1).lte(10).optional(),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  if (id !== restaurantId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "No valid fields." }, { status: 400 });
  }

  const { error } = await supabase
    .from("restaurants")
    .update(parsed.data)
    .eq("id", id);

  if (error) {
    console.error("restaurant update failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "restaurant", phase: "update" },
      extra: { restaurantId, id },
    });
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/restaurant/[id] — delete a restaurant (owner-only).
 *
 * Managers and staff receive 403 via requireOwner().
 * DB-level ON DELETE CASCADE handles cleanup of related rows
 * (wines, inventory_items, memberships, invitations, etc.).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  if (id !== restaurantId) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const { error } = await supabase
    .from("restaurants")
    .delete()
    .eq("id", restaurantId);

  if (error) {
    console.error("restaurant delete failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "restaurant", phase: "delete" },
      extra: { restaurantId },
    });
    return NextResponse.json(
      { error: "Failed to delete restaurant." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
