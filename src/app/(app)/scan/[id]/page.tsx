import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import type { LineItem } from "@/lib/scanner/types";
import { ScanDetailView } from "./scan-detail-view";
import { ReExtractButton } from "./components/re-extract-button";

export const metadata: Metadata = { title: "Scan details" };

type Params = Promise<{ id: string }>;

type InventoryItemRow = {
  id: string;
  wine_id: string;
  quantity: number;
  unit_cost: number | null;
  added_at: string;
  wine_name: string;
  wine_producer: string;
  wine_vintage: number | null;
};

export default async function ScanDetailPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const auth = await getAuthContext();
  if (!auth) notFound();

  const { supabase, restaurantId } = auth;

  const { data: scan } = await supabase
    .from("invoice_scans")
    .select(
      "id, distributor_name, invoice_number, invoice_date, accuracy_score, item_count, created_at, final_line_items, raw_image_path, ocr_text",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!scan) notFound();

  const items: LineItem[] = ((scan.final_line_items ?? []) as Array<Record<string, unknown>>).map(
    (it, idx) => ({
      id: `${scan.id}-${idx}`,
      name: (it.name as string) ?? "",
      producer: (it.producer as string) ?? "",
      vintage: (it.vintage as number | null) ?? null,
      varietal: (it.varietal as string) ?? "",
      region: (it.region as string) ?? "",
      qty: (it.qty as number) ?? 0,
      unitCost: (it.unitCost as number) ?? 0,
      currency: (it.currency as string | null) ?? null,
      format: (it.format as string | null) ?? null,
      confidence: (it.confidence as number) ?? 1,
    }),
  );

  // Fetch linked inventory items with wine names
  const { data: inventoryItems } = await supabase
    .from("inventory_items")
    .select(
      "id, wine_id, quantity, unit_cost, added_at",
    )
    .eq("invoice_scan_id", id)
    .eq("restaurant_id", restaurantId)
    .order("added_at", { ascending: true });

  // Fetch wine details for inventory items
  const wineIds = [...new Set((inventoryItems ?? []).map((i) => i.wine_id))];
  const wineMap = new Map<string, { name: string; producer: string; vintage: number | null }>();

  if (wineIds.length > 0) {
    const { data: wines } = await supabase
      .from("wines")
      .select("id, name, producer, vintage")
      .in("id", wineIds)
      .eq("restaurant_id", restaurantId);

    for (const w of wines ?? []) {
      wineMap.set(w.id, { name: w.name, producer: w.producer, vintage: w.vintage });
    }
  }

  const linkedItems: InventoryItemRow[] = (inventoryItems ?? []).map((ii) => {
    const wine = wineMap.get(ii.wine_id);
    return {
      id: ii.id,
      wine_id: ii.wine_id,
      quantity: ii.quantity,
      unit_cost: ii.unit_cost,
      added_at: ii.added_at,
      wine_name: wine?.name ?? "Unknown",
      wine_producer: wine?.producer ?? "",
      wine_vintage: wine?.vintage ?? null,
    };
  });

  const ocrText = scan.ocr_text as Record<string, unknown> | null;

  return (
    <>
      <ReExtractButton scanId={scan.id} />
      <ScanDetailView
        id={scan.id}
        distributor={scan.distributor_name}
        invoiceNumber={scan.invoice_number}
        invoiceDate={scan.invoice_date}
        accuracy={scan.accuracy_score != null ? Math.round(scan.accuracy_score * 100) : null}
        itemCount={scan.item_count}
        createdAt={scan.created_at}
        items={items}
        hasImage={!!scan.raw_image_path}
        ocrText={ocrText}
        inventoryItems={linkedItems}
      />
    </>
  );
}
