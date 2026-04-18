import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
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

  // Update each item's position
  const updates = body.orderedIds.map((id, idx) =>
    supabase
      .from("wine_list_items")
      .update({ position: idx })
      .eq("id", id),
  );

  const results = await Promise.all(updates);
  const failed = results.find((r) => r.error);

  if (failed?.error) {
    console.error("reorder failed:", failed.error);
    return NextResponse.json({ error: "Reorder failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
