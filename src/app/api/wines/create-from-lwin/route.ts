import { NextResponse, type NextRequest } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  let body: {
    lwin_id?: string;
    display_name?: string;
    producer?: string | null;
    varietal?: string | null;
    region?: string | null;
    country?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
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

  // ARCH-014: the wineId just came from find_or_create_wines_batch
  // (which is restaurant-scoped internally), so the current flow is
  // safe. The .eq('restaurant_id', …) is here so a future refactor
  // that lets wineId come from user input doesn't silently become
  // cross-tenant.
  const { error: lwinError } = await supabase
    .from("wines")
    .update({ lwin_id: lwin_id as string })
    .eq("id", wineId)
    .eq("restaurant_id", restaurantId);
  if (lwinError) {
    console.error("Failed to set lwin_id on wine:", lwinError);
  }

  return NextResponse.json({ id: wineId });
}
