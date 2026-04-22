import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

/**
 * BND-026 / ARCH-007 — atomic reorder via reorder_wine_list_items RPC.
 * All positions land in one transaction or none do; no more half-reordered
 * lists on a mid-batch failure.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

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

  const { error } = await supabase.rpc("reorder_wine_list_items", {
    p_ordered_ids: body.orderedIds,
  });

  if (error) {
    console.error("reorder failed:", error);
    return NextResponse.json({ error: "Reorder failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
