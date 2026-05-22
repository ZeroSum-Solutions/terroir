import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireRole } from "@/lib/api/auth";
import { areAllOwnWineListItems } from "@/lib/api/wine-list-scope";

export const runtime = "nodejs";

/**
 * BND-026 / ARCH-007 — atomic reorder via reorder_wine_list_items RPC.
 * All positions land in one transaction or none do; no more half-reordered
 * lists on a mid-batch failure.
 *
 * ARCH-014: also verifies every orderedId belongs to a wine list owned
 * by the caller's restaurant BEFORE hitting the RPC. Otherwise a
 * client-supplied id array could include a cross-tenant item and rely
 * on RLS alone to block the position write.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: { orderedIds: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!Array.isArray(body.orderedIds) || body.orderedIds.length === 0) {
    return NextResponse.json(
      { error: "orderedIds array is required." },
      { status: 400 },
    );
  }

  // ARCH-014: reject the batch if any id is cross-tenant (or missing).
  if (!(await areAllOwnWineListItems(supabase, body.orderedIds, restaurantId))) {
    return NextResponse.json(
      { error: "One or more items not found." },
      { status: 404 },
    );
  }

  const { error } = await supabase.rpc("reorder_wine_list_items", {
    p_ordered_ids: body.orderedIds,
  });

  if (error) {
    console.error("reorder failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-list-items", phase: "reorder-rpc" },
      extra: { restaurantId, itemCount: body.orderedIds.length },
    });
    return NextResponse.json({ error: "Reorder failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
