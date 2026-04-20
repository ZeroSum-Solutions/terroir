import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

const CellarConfigSchema = z.object({
  rows: z.number().int().min(1).max(26).optional(),
  columns: z.number().int().min(1).max(30).optional(),
  name: z.string().min(1).optional(),
});

export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data: config } = await supabase
    .from("cellar_config")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .limit(1)
    .single();

  return NextResponse.json(config ?? null);
}

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = CellarConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const rows = Math.max(1, Math.min(body.rows ?? 10, 26));
  const columns = Math.max(1, Math.min(body.columns ?? 10, 30));

  const { data: config, error } = await supabase
    .from("cellar_config")
    .insert({
      restaurant_id: restaurantId,
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
