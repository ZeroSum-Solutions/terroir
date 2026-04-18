import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await supabase
    .from("memberships")
    .select("restaurant_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership) {
    return NextResponse.json({ error: "No restaurant." }, { status: 403 });
  }

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  let query = supabase
    .from("wines")
    .select("id, name, producer, vintage, varietal, region")
    .eq("restaurant_id", membership.restaurant_id)
    .order("producer")
    .limit(20);

  if (q) {
    // Search by producer or name (case-insensitive)
    query = query.or(`name.ilike.%${q}%,producer.ilike.%${q}%`);
  }

  const { data: wines, error } = await query;

  if (error) {
    console.error("wines search failed:", error);
    return NextResponse.json({ error: "Search failed." }, { status: 500 });
  }

  return NextResponse.json(wines ?? []);
}
