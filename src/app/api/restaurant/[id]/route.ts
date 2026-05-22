import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireAuth, requireOwner } from "@/lib/api/auth";
import { setActiveRestaurant } from "@/lib/api/active-restaurant";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, user } = auth;

  const { data: membership } = await supabase
    .from("memberships")
    .select("role, restaurants(name)")
    .eq("user_id", user.id)
    .eq("restaurant_id", id)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json(
      { error: "Not a member of this restaurant." },
      { status: 403 },
    );
  }

  const restaurant = membership.restaurants as { name: string } | null;

  return NextResponse.json({
    id,
    name: restaurant?.name ?? "My Restaurant",
    role: membership.role,
  });
}

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
// columns. BND-173: added eightysix_strategy for hide-vs-mark on /list/[slug].
const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    auto_eightysix_from_inventory: z.boolean().optional(),
    eightysix_ml_threshold: z.number().int().min(0).max(5000).optional(),
    default_target_pour_cost_pct: z.number().gt(0).lt(100).optional(),
    default_target_markup_ratio: z.number().gte(1).lte(10).optional(),
    // BND-173 — how 86'd wines appear on public lists
    eightysix_strategy: z.enum(["hide", "mark"]).optional(),
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
