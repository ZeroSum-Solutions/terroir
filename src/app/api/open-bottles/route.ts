import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/open-bottles
 *
 * BND-038. Returns every by-the-glass wine (wine_list_items.glass_pour_ml
 * IS NOT NULL) for the caller's restaurant, joined with its current
 * open_bottles state (null if no bottle open), pour config, and sealed
 * inventory count. Consumed by the /pour and /reconcile server
 * components.
 *
 * Auth: requireMembership (all three roles — staff taps too).
 *
 * Delegates to the `list_open_bottle_items` RPC (stable, SECURITY
 * DEFINER, RLS-scoped via is_member).
 */
export async function GET(_request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data, error } = await supabase.rpc("list_open_bottle_items", {
    p_restaurant_id: restaurantId,
  });

  if (error) {
    console.error("open-bottles fetch failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "pour", phase: "list_open_bottle_items-rpc" },
      extra: { restaurantId },
    });
    return NextResponse.json({ error: "Failed to load." }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
}
