import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JoinedWineRow = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  is_eightysixed: boolean;
  eightysixed_at: string | null;
  eightysixed_by_user: { id: string; email: string } | null;
};

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
 */
export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const { data, error } = await supabase
    .from("wines")
    .select(
      "id, name, producer, vintage, varietal, region, is_eightysixed, eightysixed_at, eightysixed_by_user:eightysixed_by ( id, email )",
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

  const wines = ((data ?? []) as unknown as JoinedWineRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    producer: row.producer,
    vintage: row.vintage,
    varietal: row.varietal,
    region: row.region,
    is_eightysixed: row.is_eightysixed,
    eightysixed_at: row.eightysixed_at,
    eightysixed_by: row.eightysixed_by_user,
  }));

  return NextResponse.json({ wines });
}
