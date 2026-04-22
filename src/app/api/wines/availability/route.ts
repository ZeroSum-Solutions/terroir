import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/wines/availability
 *
 * BND-037. Returns every wine in the caller's restaurant with its
 * current 86'd state. Consumed by the /availability page (browse +
 * toggle). No pagination — typical restaurant has <1000 wines and
 * client-side filtering is plenty.
 *
 * Auth: requireMembership (all three roles). The PATCH sibling is
 * role-gated via requireRole(['owner','manager']); this endpoint is
 * intentionally readable by staff.
 *
 * Note: the `eightysixed_by` column holds a `uuid` referencing
 * `auth.users(id)`. We intentionally do NOT embed the user's email
 * here — PostgREST can't resolve embeds across schema boundaries
 * (auth vs public) and exposing `auth` in the PostgREST schema
 * config would be a security regression. If attributing 86's to
 * named people matters later, add a public-schema view that
 * joins memberships -> auth.users and scopes to the caller's
 * restaurant via RLS, then embed through that.
 */
export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data, error } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, varietal, region, is_eightysixed, eightysixed_at, eightysixed_by",
    )
    .eq("restaurant_id", restaurantId)
    .order("name", { ascending: true });

  if (error) {
    console.error("wines availability fetch failed:", error);
    return NextResponse.json(
      { error: "Failed to load wines." },
      { status: 500 },
    );
  }

  return NextResponse.json({ wines: data ?? [] });
}
