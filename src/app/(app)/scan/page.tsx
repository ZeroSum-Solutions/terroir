import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { Scanner } from "./scanner";
import type { RecentScan } from "@/lib/scanner/types";

export const metadata: Metadata = { title: "Scan" };

export default async function ScannerPage() {
  const auth = await getAuthContext();

  let recentScans: RecentScan[] = [];

  if (auth) {
    const { supabase, restaurantId } = auth;

    const { data: scans } = await supabase
      .from("invoice_scans")
      .select("id, distributor_name, item_count, accuracy_score, created_at, final_line_items, raw_image_path")
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false })
      .limit(5);

      recentScans = (scans ?? []).map((s) => {
        // Compute total from final_line_items
        const items = (s.final_line_items ?? []) as Array<{
          qty: number;
          unitCost: number;
        }>;
        const total = items.reduce(
          (sum, it) => sum + (it.qty ?? 0) * (it.unitCost ?? 0),
          0,
        );
        return {
          id: s.id,
          parsedAt: s.created_at,
          distributor: s.distributor_name,
          items: s.item_count,
          total,
          accuracy: Math.round((s.accuracy_score ?? 0) * 100),
          hasImage: !!s.raw_image_path,
        };
      });
  }

  return <Scanner recentScans={recentScans} />;
}
