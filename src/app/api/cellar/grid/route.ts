import * as Sentry from "@sentry/nextjs";
import { Errors } from "@/lib/api/errors";
import { NextResponse } from "next/server";
import { requireMembership } from "@/lib/api/auth";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  // Fetch inventory items with bin_location and wine info
  const { data: items, error } = await supabase
    .from("inventory_items")
    // CELLAR-08: hero_image_url and colour ride along so a bin card can show
    // what the bottle looks like. Staff sent to "Bin A5" find ten different
    // bottles there; a name alone doesn't tell them which one.
    .select("bin_location, quantity, wines(id, name, producer, vintage, hero_image_url, colour)")
    .eq("restaurant_id", restaurantId)
    .not("bin_location", "is", null);

  if (error) {
    console.error("cellar grid failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "cellar", phase: "grid-list-rpc" },
      extra: { restaurant_id: restaurantId },
    });
    return Errors.internal("Failed to fetch grid data.");
  }

  // Group by bin_location
  const grid: Record<
    string,
    {
      wines: Array<{
        wineId: string;
        name: string;
        producer: string;
        vintage: number | null;
        quantity: number;
        heroImageUrl: string | null;
        colour: string | null;
      }>;
      totalBottles: number;
    }
  > = {};

  for (const item of items ?? []) {
    if (!item.bin_location) continue;

    const bin = item.bin_location.toUpperCase().trim();
    const wine = item.wines as {
      id: string;
      name: string;
      producer: string;
      vintage: number | null;
      hero_image_url: string | null;
      colour: string | null;
    } | null;

    if (!wine) continue;

    if (!grid[bin]) {
      grid[bin] = { wines: [], totalBottles: 0 };
    }

    grid[bin].wines.push({
      wineId: wine.id,
      name: wine.name,
      producer: wine.producer,
      vintage: wine.vintage,
      quantity: item.quantity,
      heroImageUrl: wine.hero_image_url,
      colour: wine.colour,
    });
    grid[bin].totalBottles += item.quantity;
  }

  return NextResponse.json(grid);
}
