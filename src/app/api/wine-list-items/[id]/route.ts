import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  const { error } = await supabase
    .from("wine_list_items")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("wine_list_items delete failed:", error);
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase } = auth;

  let body: {
    glass_price?: number | null;
    bottle_price?: number | null;
    tasting_note?: string;
    is_available?: boolean;
    position?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const allowed: {
    glass_price?: number | null;
    bottle_price?: number | null;
    tasting_note?: string;
    is_available?: boolean;
    position?: number;
  } = {};
  if (body.glass_price !== undefined) allowed.glass_price = body.glass_price;
  if (body.bottle_price !== undefined) allowed.bottle_price = body.bottle_price;
  if (body.tasting_note !== undefined) allowed.tasting_note = body.tasting_note;
  if (body.is_available !== undefined) allowed.is_available = body.is_available;
  if (body.position !== undefined) allowed.position = body.position;

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields." }, { status: 400 });
  }

  const { error } = await supabase
    .from("wine_list_items")
    .update(allowed)
    .eq("id", id);

  if (error) {
    console.error("wine_list_items update failed:", error);
    return NextResponse.json({ error: "Update failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
