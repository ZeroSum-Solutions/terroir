import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";

  let query = supabase
    .from("wines")
    .select("id, name, producer, vintage, varietal, region")
    .eq("restaurant_id", restaurantId)
    .order("producer")
    .limit(20);

  if (q) {
    // Search by producer or name (case-insensitive)
    query = query.or(`name.ilike.%${q}%,producer.ilike.%${q}%`);
  }

  const { data: wines, error } = await query;

  if (error) {
    console.error("wines search failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wines-search", phase: "query" },
      extra: { restaurantId, q },
    });
    return NextResponse.json({ error: "Search failed." }, { status: 500 });
  }

  return NextResponse.json(wines ?? []);
}
