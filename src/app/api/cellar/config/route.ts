import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
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
    return NextResponse.json(
      { error: "No restaurant membership found." },
      { status: 403 },
    );
  }

  const { data: config } = await supabase
    .from("cellar_config")
    .select("*")
    .eq("restaurant_id", membership.restaurant_id)
    .limit(1)
    .single();

  return NextResponse.json(config ?? null);
}

export async function POST(request: NextRequest) {
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
    return NextResponse.json(
      { error: "No restaurant membership found." },
      { status: 403 },
    );
  }

  let body: { rows?: number; columns?: number; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const rows = Math.max(1, Math.min(body.rows ?? 10, 26));
  const columns = Math.max(1, Math.min(body.columns ?? 10, 30));

  const { data: config, error } = await supabase
    .from("cellar_config")
    .insert({
      restaurant_id: membership.restaurant_id,
      name: body.name ?? "Main Cellar",
      rows,
      columns,
    })
    .select("*")
    .single();

  if (error) {
    console.error("cellar_config insert failed:", error);
    return NextResponse.json(
      { error: "Failed to create cellar configuration." },
      { status: 500 },
    );
  }

  return NextResponse.json(config);
}
