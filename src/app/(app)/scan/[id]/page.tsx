import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";
import type { LineItem } from "@/lib/scanner/types";
import { ScanDetailView } from "./scan-detail-view";
import { ReExtractButton } from "./components/re-extract-button";

export const metadata: Metadata = { title: "Scan details" };

type Params = Promise<{ id: string }>;

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
      "id, distributor_name, invoice_number, invoice_date, accuracy_score, item_count, created_at, final_line_items, raw_image_path",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .single();

  if (!scan) notFound();

  const items = ((scan.final_line_items ?? []) as Array<Record<string, unknown>>).map(
    (it, idx) => ({
      id: `${scan.id}-${idx}`,
      name: (it.name as string) ?? "",
      producer: (it.producer as string) ?? "",
      vintage: (it.vintage as number | null) ?? null,
      varietal: (it.varietal as string) ?? "",
      region: (it.region as string) ?? "",
      qty: (it.qty as number) ?? 0,
      unitCost: (it.unitCost as number) ?? 0,
      confidence: (it.confidence as number) ?? 1,
    }),
  ) satisfies LineItem[];

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
      />
    </>
  );
}
