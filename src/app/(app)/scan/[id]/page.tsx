import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import type { LineItem } from "@/lib/scanner/types";
import { describeScanStatusReason } from "@/lib/scanner/scan-status-reason";
import { ScanReview } from "../components/scan-review";
import { DeleteScanButton } from "./components/delete-scan-button";
import { ReExtractButton } from "./components/re-extract-button";
import {
  ScanInventoryList,
  type ScanInventoryItem,
} from "./components/scan-inventory-list";

export const metadata: Metadata = { title: "Scan review" };

type Params = Promise<{ id: string }>;

export default async function ScanDetailPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const auth = await getAuthContext();
  if (!auth) notFound();

  const { supabase, restaurantId, userRole } = auth;

  const { data: scan } = await supabase
    .from("invoice_scans")
    .select(
      "id, distributor_name, invoice_number, invoice_date, accuracy_score, item_count, created_at, final_line_items, raw_image_path, status, status_reason"
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!scan) notFound();

  // SCAN-04 / D6 rule 3: the delete confirmation states the bottle-count
  // impact BEFORE the user commits, so it is read here rather than
  // discovered after the fact. Same link delete_invoice_scan (0143) uses.
  // The wine columns ride along on the same read so the committed bottles can
  // also be listed — and opened — below the review.
  const { data: linkedInventory } = await supabase
    .from("inventory_items")
    .select(
      "id, wine_id, quantity, unit_cost, added_at, wines(name, producer, vintage, hero_image_url, colour)",
    )
    .eq("invoice_scan_id", id)
    .eq("restaurant_id", restaurantId)
    .order("added_at", { ascending: true });
  const inventoryRows = linkedInventory?.length ?? 0;
  const bottles = (linkedInventory ?? []).reduce((sum, row) => sum + (row.quantity ?? 0), 0);

  // Only committed rows have a wine id, so this is empty until the scan has
  // been committed — which is exactly when there is a wine to open.
  const inventoryItems: ScanInventoryItem[] = (linkedInventory ?? []).flatMap((row) => {
    if (!row.wines) return [];
    return [{
      id: row.id,
      wineId: row.wine_id,
      quantity: row.quantity,
      unitCost: row.unit_cost,
      name: row.wines.name,
      producer: row.wines.producer,
      vintage: row.wines.vintage,
      heroImageUrl: row.wines.hero_image_url,
      colour: row.wines.colour,
    }];
  });

  const statusReason = describeScanStatusReason(scan.status_reason);

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
    })
  );

  return (
    <>
      {/* D6 rule 1: a scan that found nothing or failed stays here, and
          says why. Without this a 0-item "complete" row and a 0-item
          "failed" row are indistinguishable to the person reading them. */}
      {statusReason && (
        <p
          role="status"
          className="mb-md rounded-card border border-rule bg-wash px-md py-sm text-body-sm text-ink-soft"
        >
          {statusReason}
        </p>
      )}
      <div className="mb-md flex flex-wrap items-start justify-between gap-sm">
        <ReExtractButton scanId={scan.id} />
        <DeleteScanButton
          scanId={scan.id}
          distributor={scan.distributor_name}
          inventoryRows={inventoryRows}
          bottles={bottles}
          canDelete={userRole === "owner" || userRole === "manager"}
        />
      </div>
      <ScanReview
        id={scan.id}
        distributor={scan.distributor_name}
        invoiceNumber={scan.invoice_number}
        invoiceDate={scan.invoice_date}
        accuracy={scan.accuracy_score != null ? Math.round(scan.accuracy_score * 100) : null}
        itemCount={scan.item_count}
        createdAt={scan.created_at}
        items={items}
        hasImage={!!scan.raw_image_path}
      />
      <ScanInventoryList items={inventoryItems} />
    </>
  );
}