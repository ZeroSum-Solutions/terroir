import Link from "next/link";
import { WineThumb } from "@/components/wine-thumb";
import { wineDisplayName } from "@/lib/wine-display-name";

/**
 * The wines a scan actually put in the cellar, each one openable.
 *
 * The review surface above this lists the invoice's LINE ITEMS — text fields on
 * a card, editable, and correctly not links: a line item is not a wine yet, it
 * has no wine id, and there is nothing to open. Only a committed scan has wines,
 * and until now the page never said so: a somm could commit four bottles and
 * then have no way to reach any of them from the scan that created them.
 *
 * The same block exists, fully written, in `[id]/scan-detail-view.tsx` — a
 * read-only page component that nothing imports. It was not wired up because it
 * has no Save Edits and no Commit to Inventory, so adopting it would have traded
 * this gap for the loss of the whole commit path. Only the part that was
 * missing is ported here.
 */

export type ScanInventoryItem = {
  id: string;
  wineId: string;
  quantity: number;
  unitCost: number | null;
  name: string;
  producer: string;
  vintage: number | null;
  heroImageUrl: string | null;
  colour: string | null;
};

function formatMoney(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function ScanInventoryList({ items }: { items: ScanInventoryItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-lg">
      <div className="mb-md text-caption font-medium uppercase tracking-[0.18em] text-grey">
        Inventory created
      </div>
      <div className="flex flex-col gap-sm">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/cellar?wine=${encodeURIComponent(item.wineId)}`}
            className="flex min-h-11 items-center gap-md rounded-card card-surface p-md hover:bg-wash focus-ring"
          >
            <WineThumb
              src={item.heroImageUrl}
              producer={item.producer}
              name={item.name}
              colour={item.colour}
              size={40}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-serif text-body-lg font-medium leading-snug text-ink">
                {wineDisplayName(item.producer, item.name)}
              </span>
              <span className="mt-2xs block text-body-sm text-grey">
                {item.producer}
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="tabular block text-body-sm text-ink">
                {item.vintage ?? "NV"}
              </span>
              <span className="tabular mt-2xs block text-ledger text-grey">
                {item.quantity} ×{" "}
                {item.unitCost != null ? `$${formatMoney(item.unitCost)}` : "—"}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
