import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMembership, requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";

export const runtime = "nodejs";

const BinBodySchema = z.strictObject({
  code: z.string().trim().min(1).max(50),
  zone: z.string().trim().max(100).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  priority: z.number().int().optional(),
});

const BIN_FIELDS = "id, code, zone, capacity, priority, sort_order";

type InventoryRow = {
  bin_id: string | null;
  wine_id: string;
  quantity: number;
};

function reportFailure(
  phase: "list" | "occupancy" | "create",
  restaurantId: string,
) {
  const message = `bins ${phase} failed`;
  console.error(message);
  Sentry.captureException(new Error(message), {
    tags: { surface: "bins", phase },
    extra: { restaurantId },
  });
}

function occupancyByBin(rows: InventoryRow[]) {
  const result = new Map<string, { wines: Set<string>; bottles: number }>();
  for (const row of rows) {
    if (!row.bin_id) continue;
    const current = result.get(row.bin_id) ?? {
      wines: new Set<string>(),
      bottles: 0,
    };
    current.wines.add(row.wine_id);
    current.bottles += row.quantity;
    result.set(row.bin_id, current);
  }
  return result;
}

export async function GET() {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const { data: bins, error } = await supabase
      .from("bins")
      .select(BIN_FIELDS)
      .eq("restaurant_id", restaurantId)
      .is("retired_at", null)
      .order("sort_order")
      .order("code");

    if (error) {
      reportFailure("list", restaurantId);
      return Errors.internal("Failed to fetch bins.");
    }
    if (!bins?.length) return NextResponse.json([]);

    const { data: inventory, error: inventoryError } = await supabase
      .from("inventory_items")
      .select("bin_id, wine_id, quantity")
      .eq("restaurant_id", restaurantId)
      .in(
        "bin_id",
        bins.map((bin) => bin.id),
      );

    if (inventoryError) {
      reportFailure("occupancy", restaurantId);
      return Errors.internal("Failed to fetch bin occupancy.");
    }

    const occupancy = occupancyByBin(inventory ?? []);
    return NextResponse.json(
      bins.map((bin) => ({
        ...bin,
        wine_count: occupancy.get(bin.id)?.wines.size ?? 0,
        bottle_count: occupancy.get(bin.id)?.bottles ?? 0,
      })),
    );
  });
}

export async function POST(request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireRole(["owner", "manager"]);
    if (auth instanceof NextResponse) return auth;
    const { supabase, restaurantId } = auth;

    const parsed = await parseJson(request, BinBodySchema);
    if (!parsed.ok) return parsed.response;

    const { data, error } = await supabase
      .from("bins")
      .insert({ restaurant_id: restaurantId, ...parsed.data })
      .select(BIN_FIELDS)
      .single();

    if (error?.code === "23505") {
      return Errors.conflict(
        "duplicate_bin_code",
        "A bin with that code already exists.",
      );
    }
    if (error || !data) {
      reportFailure(
        "create",
        restaurantId,
      );
      return Errors.internal("Failed to create bin.");
    }
    return NextResponse.json(data, { status: 201 });
  });
}
