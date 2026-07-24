import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { loadCellarGrid } from "@/lib/cellar/grid";

export const runtime = "nodejs";

export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const grid = await loadCellarGrid(supabase, restaurantId);
    return NextResponse.json(grid);
  });
}
