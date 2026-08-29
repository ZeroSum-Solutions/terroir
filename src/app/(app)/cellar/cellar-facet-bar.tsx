import { useMemo, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import {
  hasSelectableOptions,
  type CellarFacets,
  type CellarGroupBy,
  type FacetCount,
  type FacetCounts,
} from "@/lib/cellar-facets";
import type { CellarHealthSegment } from "@/lib/cellar-health/classify";
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
 * M2-15 §2.4 — filter consolidation.
 *
 * The ~8 dropdowns this bar used to render inline (Producer, Region,
 * Country, Varietal, Vintage from, Vintage to, Format, Group by) wrapped
 * across 4+ lines on mobile, several with only one useful choice on a
 * given cellar. Now: Producer/Region — the two most commonly used
 * filters — stay in one compact row (auto-hidden if the current result
 * set only has one value for them); everything else moves into a single
 * "Filters" sheet; and every active filter (from either surface, plus any
 * that arrived via a deep link like `?health=`) shows as one removable
 * chip so the whole filter state is visible and clearable at a glance.
 */
export function CellarFacetBar({
  facets,
  counts,
  groupBy,
  onFacetsChange,
  onGroupByChange,
}: {
  facets: CellarFacets;
  counts: FacetCounts;
  groupBy: CellarGroupBy | null;
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);

  const showProducer = hasSelectableOptions(counts.producer);
  const showRegion = hasSelectableOptions(counts.region);
  const showCountry = hasSelectableOptions(counts.country);
  const showVarietal = hasSelectableOptions(counts.varietal);
  const showVintage = hasSelectableOptions(counts.vintage);
  const showFormat = hasSelectableOptions(counts.format);
  const hasAnySecondaryControl = showCountry || showVarietal || showVintage || showFormat;

  const secondaryActiveCount =
    (facets.country ? 1 : 0) +
    (facets.varietal ? 1 : 0) +
    (facets.vintageMin != null || facets.vintageMax != null ? 1 : 0) +
    (facets.format != null ? 1 : 0) +
    (groupBy ? 1 : 0);

  const appliedChips = useMemo(
    () => buildAppliedChips({ facets, groupBy, onFacetsChange, onGroupByChange }),
    [facets, groupBy, onFacetsChange, onGroupByChange],
  );

  if (!showProducer && !showRegion && !hasAnySecondaryControl && appliedChips.length === 0) {
    // Nothing here would do anything useful — a single-value cellar (or an
    // empty one) has no facet worth showing a control for.
    return null;
  }

  return (
    <div data-cellar-facet-bar className="mb-md flex max-w-full flex-col gap-sm">
      {/*
        M2-15 §2.4 follow-up (residuals audit) — Producer/Region + the
        Filters button must read as ONE compact row, never a wrapped
        multi-row block, down to 320px. `flex-nowrap` plus each select's
        narrower mobile cap (below) keeps all three controls on one line
        at 320–430px with room to spare; `overflow-x-auto` is a safety net
        for unusually long producer/region text, not the primary UX.
      */}
      <div className="flex flex-nowrap items-center gap-xs overflow-x-auto">
        {showProducer && (
          <FacetSelect
            label="Producer"
            value={facets.producer}
            options={counts.producer}
            onChange={(producer) => onFacetsChange({ producer })}
          />
        )}
        {showRegion && (
          <FacetSelect
            label="Region"
            value={facets.region}
            options={counts.region}
            onChange={(region) => onFacetsChange({ region })}
          />
        )}
        {hasAnySecondaryControl && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex h-11 shrink-0 items-center gap-xs rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-ring"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Filters
            {secondaryActiveCount > 0 && (
              <span className="tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-primary px-xs text-[10px] text-seal-ink">
                {secondaryActiveCount}
              </span>
            )}
          </button>
        )}
      </div>

      {appliedChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2xs gap-y-lg">
          {appliedChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-8 items-center gap-2xs rounded-pill bg-bridge-surface pl-sm pr-2xs text-[11.5px] font-medium text-ink-soft"
            >
              {chip.label}
              <button
                type="button"
                onClick={chip.onRemove}
                aria-label={`Remove ${chip.label} filter`}
                className="flex h-11 w-11 shrink-0 -my-[6px] items-center justify-center rounded-pill text-grey hover:bg-surface hover:text-ink-soft focus-ring"
              >
                <X className="h-3 w-3" strokeWidth={2.5} aria-hidden />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              onFacetsChange(CLEAR_ALL_PATCH);
              onGroupByChange(null);
            }}
            className="flex h-11 shrink-0 -my-[6px] items-center justify-center rounded-pill px-sm text-[11.5px] font-medium text-grey hover:bg-bridge-surface focus-ring"
          >
            Clear all
          </button>
        </div>
      )}

      {sheetOpen && (
      <CellarFilterSheet
        facets={{
          country: facets.country ?? null,
          varietal: facets.varietal ?? null,
          vintageMin: facets.vintageMin ?? null,
          vintageMax: facets.vintageMax ?? null,
          format: facets.format ?? null,
        }}
        counts={counts}
        groupBy={groupBy}
        onApply={(patch, nextGroupBy) => {
          onFacetsChange(patch);
          onGroupByChange(nextGroupBy);
        }}
        onReset={() => {
          onFacetsChange(CLEAR_ALL_PATCH);
          onGroupByChange(null);
        }}
        onClose={() => setSheetOpen(false)}
      />
      )}
    </div>
  );
}

function buildAppliedChips({
  facets,
  groupBy,
  onFacetsChange,
  onGroupByChange,
}: {
  facets: CellarFacets;
  groupBy: CellarGroupBy | null;
  onFacetsChange: (patch: CellarFacetPatch) => void;
  onGroupByChange: (groupBy: CellarGroupBy | null) => void;
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

  return chips;
}

function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  options: FacetCount[];
  onChange: (value: string | null) => void;
}) {
  const selected = options.find(
    (option) => option.value.toLocaleLowerCase() === value?.toLocaleLowerCase(),
  );
  const renderedOptions =
    value && !selected
      ? [...options, { value, label: value, count: 0, isUnknown: false }]
      : options;
  return (
    <label className="shrink-0">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={selected?.value ?? value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className={selectClassName}
      >
        {/* The unfiltered option shows just the category word — "All
            producer" clipped to "All produc…" inside the mobile width cap
            (Kimi audit 2026-08-26). */}
        <option value="">{label}</option>
        {renderedOptions.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.isUnknown}
          >
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

// Capped narrower on mobile so Producer + Region + the Filters button share
// one row down to 320px (each select would otherwise size toward its widest
// option's text); md: restores the roomier desktop width.
const selectClassName =
  "h-11 max-w-[104px] md:max-w-[180px] rounded-pill border border-edge bg-surface px-sm text-[12px] text-ink hover:bg-bridge-surface focus-ring";
