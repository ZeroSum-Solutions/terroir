import { createClient } from "@/lib/supabase/server";
import { Scanner } from "./scanner";
import type { RecentScan } from "@/lib/scanner/types";

export default async function ScannerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let recentScans: RecentScan[] = [];

  if (user) {
    const { data: membership } = await supabase
      .from("memberships")
      .select("restaurant_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();

    if (membership) {
      const { data: scans } = await supabase
        .from("invoice_scans")
        .select("id, distributor_name, item_count, accuracy_score, created_at, final_line_items")
        .eq("restaurant_id", membership.restaurant_id)
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
          parsedAt: s.created_at.slice(0, 10),
          distributor: s.distributor_name,
          items: s.item_count,
          total,
          accuracy: Math.round((s.accuracy_score ?? 0) * 100),
        };
      });
    }
  }

  return <Scanner recentScans={recentScans} />;
}
