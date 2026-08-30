import type { CellarFacetGroup } from "@/lib/cellar-facets";
import type { CellarWineRow } from "./types";
import { CellarRow } from "./cellar-row";
import { LineageBlockList } from "./lineage-block-list";

export function TaxonomyGroup({
  group,
  lowStockThreshold,
  onSelectWine,
  sortActive,
}: {
  group: CellarFacetGroup<CellarWineRow>;
  lowStockThreshold?: number;
  onSelectWine: (row: CellarWineRow) => void;
  sortActive?: boolean;
}) {
  return (
    <section
      data-cellar-taxonomy-group
      data-group-value={group.key}
      className="overflow-hidden rounded-card card-surface"
    >
      <header className="flex items-center justify-between gap-md border-b border-rule-strong bg-surface-sunken px-md py-sm">
        <h2 className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-soft">
          {group.label}
        </h2>
        <span
          data-group-rollup
          className="tabular shrink-0 text-[11px] text-ink-soft"
        >
          {group.wineCount} wine{group.wineCount === 1 ? "" : "s"} · {group.totalBottles}{" "}
          bottle{group.totalBottles === 1 ? "" : "s"}
        </span>
      </header>
      <div className="divide-y divide-rule">
        <LineageBlockList
          wines={group.wines}
          preserveOrder={sortActive}
          renderRow={(row) => (
            <CellarRow
              row={row}
              lowStockThreshold={lowStockThreshold}
              onSelect={() => onSelectWine(row)}
            />
          )}
        />
      </div>
    </section>
  );
}
