import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const body = await request.json();
  const { lwin_id, display_name, producer, varietal, region, country } = body;

  if (!display_name || !lwin_id) {
    return NextResponse.json(
      { error: "Missing required fields." },
      { status: 400 },
    );
  }

  const { data: wineIds, error } = await supabase.rpc(
    "find_or_create_wines_batch",
    {
      p_restaurant_id: restaurantId,
      p_wines: [
        {
          name: display_name,
          producer: producer ?? "Unknown",
          vintage: null,
          varietal: varietal ?? null,
          region: region ?? null,
          country: country ?? null,
          size_ml: 750,
        },
      ],
    },
  );

  if (error || !wineIds?.[0]) {
    console.error("create-from-lwin failed:", error);
    return NextResponse.json(
      { error: "Failed to create wine." },
      { status: 500 },
    );
  }

  const wineId = (wineIds as string[])[0];

  // Set lwin_id on the wine
  await supabase.from("wines").update({ lwin_id }).eq("id", wineId);

  return NextResponse.json({ id: wineId });
}
