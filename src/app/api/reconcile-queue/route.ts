import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireMembership } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { assembleQueue } from "@/lib/reconcile-ledger/queue-sources";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

type Client = SupabaseClient<Database>;
type InventoryRow = Database["public"]["Tables"]["inventory_items"]["Row"];
type ScanRow = Database["public"]["Tables"]["invoice_scans"]["Row"];
type WineRow = Database["public"]["Tables"]["wines"]["Row"];

async function querySources(client: Client, restaurantId: string) {
  const [inventory, scans, wines, bins, latest] = await Promise.all([
    client.from("inventory_items").select("*")
      .eq("restaurant_id", restaurantId).gt("quantity", 0),
    client.from("invoice_scans").select("*").eq("restaurant_id", restaurantId),
    client.from("wines").select("*").eq("restaurant_id", restaurantId),
    client.from("bins").select("*").eq("restaurant_id", restaurantId)
      .is("retired_at", null).order("priority", { ascending: false }),
    client.from("reconcile_batches").select("*").eq("restaurant_id", restaurantId)
      .is("undone_at", null).order("created_at", { ascending: false })
      .limit(1).maybeSingle(),
  ]);
  if (inventory.error || scans.error || wines.error || bins.error || latest.error) {
    throw new Error("Reconcile queue source query failed.");
  }
  return {
    inventory: inventory.data as InventoryRow[],
    scans: scans.data as ScanRow[],
    wines: wines.data as WineRow[],
    bins: bins.data,
    latestBatch: latest.data,
  };
}

export async function GET(_request: NextRequest) {
  return withApiHandler(async () => {
    const auth = await requireMembership();
    if (auth instanceof NextResponse) return auth;
    const sources = await querySources(auth.supabase, auth.restaurantId);
    const queue = assembleQueue(sources.inventory, sources.scans, sources.wines);
    return NextResponse.json({
      issues: queue.rows,
      summary: queue.summary,
      latest_batch: sources.latestBatch,
      bins: sources.bins,
    });
  });
}
