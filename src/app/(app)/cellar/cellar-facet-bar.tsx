import { useMemo } from "react";
import { X } from "lucide-react";
import type {
  CellarFacets,
  CellarGroupBy,
  FacetCounts,
} from "@/lib/cellar-facets";
import type { CellarHealthSegment } from "@/lib/cellar-health/classify";
import { CELLAR_SORT_LABELS, type CellarSort } from "@/lib/cellar-facets/sort";
import { CellarFilterSheet } from "./cellar-filter-sheet";

export type CellarFacetPatch = Partial<
  Pick<
    CellarFacets,
    | "producer"
    | "region"
    | "country"
    | "varietal"
    | "vintageMin"
    | "vintageMax"
    | "format"
    | "health"
  >
>;

const CLEAR_ALL_PATCH: CellarFacetPatch = {
  producer: null,
  region: null,
  country: null,
  varietal: null,
  vintageMin: null,
  vintageMax: null,
  format: null,
  health: null,
};

const HEALTH_LABELS: Record<CellarHealthSegment, string> = {
  window_risk: "Window risk",
  hold: "Hold",
  dead_stock: "Dead stock",
  cash_trap: "Cash trap",
  healthy: "Healthy",
};

const GROUP_BY_LABELS: Record<CellarGroupBy, string> = {
  producer: "Producer",
  region: "Region",
  varietal: "Varietal",
  vintage: "Vintage",
};

type AppliedChip = { key: string; label: string; onRemove: () => void };

/**
 * CELLAR-01 — applied-filter chips, plus the one filter surface they come from.
 *
 * This used to render its own control row: Producer, Region and a "Filters"
 * button, stacked under the shell's own two rows. Producer and Region now live
 * inside the sheet with every other facet, the sort and the grouping, and the
 * button that opens it belongs to the shell's single control row — so what is
 * left here is the state readout: one removable chip per applied filter,
 * wherever it came from (including a deep link like `?health=`).
 */
export function CellarFacetBar({
  facets,
  counts,
  groupBy,
  sort,
  open,
  onOpenChange,
  onFacetsChange,
  onGroupByChange,
  onSortChange,
  onEnterSelectMode,
}: {
  facets: CellarFacets;
  counts: FacetCounts;
  groupBy: CellarGroupBy | null;
  sort: CellarSort | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
  onSortChange: (sort: CellarSort | null) => void;
  /** Absent when this cellar has no sections to assign wines to. */
  onEnterSelectMode?: () => void;
}) {
  const appliedChips = useMemo(
    () =>
      buildAppliedChips({
        facets,
        groupBy,
        sort,
        onFacetsChange,
        onGroupByChange,
        onSortChange,
      }),
    [facets, groupBy, sort, onFacetsChange, onGroupByChange, onSortChange],
  );

  if (appliedChips.length === 0 && !open) return null;

  return (
    <div data-cellar-facet-bar className="mb-md flex max-w-full flex-col gap-sm">
      {appliedChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2xs gap-y-lg">
          {appliedChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-8 items-center gap-2xs rounded-pill bg-wash pl-sm pr-2xs text-caption font-medium tracking-normal text-ink-soft"
            >
              {chip.label}
              <button
                type="button"
                onClick={chip.onRemove}
                aria-label={`Remove ${chip.label} filter`}
                className="flex h-11 w-11 shrink-0 -my-[6px] items-center justify-center rounded-pill text-grey hover:bg-surface hover:text-ink-soft focus-ring"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              onFacetsChange(CLEAR_ALL_PATCH);
              onGroupByChange(null);
              onSortChange(null);
            }}
            className="flex h-11 shrink-0 -my-[6px] items-center justify-center rounded-pill px-sm text-caption font-medium tracking-normal text-grey hover:bg-wash focus-ring"
          >
            Clear all
          </button>
        </div>
      )}

      {open && (
        <CellarFilterSheet
          facets={{
            producer: facets.producer ?? null,
            region: facets.region ?? null,
            country: facets.country ?? null,
            varietal: facets.varietal ?? null,
            vintageMin: facets.vintageMin ?? null,
            vintageMax: facets.vintageMax ?? null,
            format: facets.format ?? null,
          }}
          counts={counts}
          groupBy={groupBy}
          sort={sort}
          onApply={(patch, nextGroupBy, nextSort) => {
            onFacetsChange(patch);
            onGroupByChange(nextGroupBy);
            onSortChange(nextSort);
          }}
          onReset={() => {
            onFacetsChange(CLEAR_ALL_PATCH);
            onGroupByChange(null);
            onSortChange(null);
          }}
          onEnterSelectMode={onEnterSelectMode}
          onClose={() => onOpenChange(false)}
        />
      )}
    </div>
  );
}

function buildAppliedChips({
  facets,
  groupBy,
  sort,
  onFacetsChange,
  onGroupByChange,
  onSortChange,
}: {
  facets: CellarFacets;
  groupBy: CellarGroupBy | null;
  sort: CellarSort | null;
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
  onSortChange: (sort: CellarSort | null) => void;
}): AppliedChip[] {
  const chips: AppliedChip[] = [];

  if (facets.producer) {
    chips.push({
      key: "producer",
      label: `Producer: ${facets.producer}`,
      onRemove: () => onFacetsChange({ producer: null }),
    });
  }
  if (facets.region) {
    chips.push({
      key: "region",
      label: `Region: ${facets.region}`,
      onRemove: () => onFacetsChange({ region: null }),
    });
  }
  if (facets.country) {
    chips.push({
      key: "country",
      label: `Country: ${facets.country}`,
      onRemove: () => onFacetsChange({ country: null }),
    });
  }
  if (facets.varietal) {
    chips.push({
      key: "varietal",
      label: `Varietal: ${facets.varietal}`,
      onRemove: () => onFacetsChange({ varietal: null }),
    });
  }
  if (facets.vintageMin != null || facets.vintageMax != null) {
    const label =
      facets.vintageMin != null && facets.vintageMax != null
        ? `Vintage: ${facets.vintageMin}–${facets.vintageMax}`
        : facets.vintageMin != null
          ? `Vintage from ${facets.vintageMin}`
          : `Vintage to ${facets.vintageMax}`;
    chips.push({
      key: "vintage",
      label,
      onRemove: () => onFacetsChange({ vintageMin: null, vintageMax: null }),
    });
  }
  if (facets.format != null) {
    chips.push({
      key: "format",
      label: `Format: ${facets.format} ml`,
      onRemove: () => onFacetsChange({ format: null }),
    });
  }
  if (facets.health) {
    chips.push({
      key: "health",
      label: `Health: ${HEALTH_LABELS[facets.health]}`,
      onRemove: () => onFacetsChange({ health: null }),
    });
  }
  if (groupBy) {
    chips.push({
      key: "group-by",
      label: `Group: ${GROUP_BY_LABELS[groupBy]}`,
      onRemove: () => onGroupByChange(null),
    });
  }
  // Sort moved into the filter sheet with the grouping, so it needs the same
  // visible, removable readout — otherwise a non-default sort would be applied
  // with nothing on the page saying so.
  if (sort) {
    chips.push({
      key: "sort",
      label: `Sort: ${CELLAR_SORT_LABELS[sort]}`,
      onRemove: () => onSortChange(null),
    });
  }

  return chips;
}
