"use client";

import { Loader2, Sparkles } from "lucide-react";
import type { PricingSuggestion } from "./add-wine-modal.types";

/**
 * BND-040 / LIST-03 — the add-wine modal's pricing block: the suggestion
 * panel and the two price fields it fills.
 *
 * Split out of `add-wine-modal.tsx` so that file stays under the size ratchet.
 * The suggestion is applied to the inputs automatically when it arrives (see
 * `add-wine-modal.tsx`); "Use these" now only restores it after an edit.
 */
export function AddWinePricing({
  suggesting,
  suggestion,
  suggestError,
  glassPrice,
  bottlePrice,
  onGlassPriceChange,
  onBottlePriceChange,
  onApplySuggestion,
}: {
  suggesting: boolean;
  suggestion: PricingSuggestion | null;
  suggestError: string | null;
  glassPrice: string;
  bottlePrice: string;
  onGlassPriceChange: (value: string) => void;
  onBottlePriceChange: (value: string) => void;
  onApplySuggestion: () => void;
}) {
  return (
    <>
      {suggesting && (
        <div className="mt-md flex items-center gap-xs text-ledger text-grey">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />
          Computing suggestion…
        </div>
      )}
      {!suggesting && suggestion && suggestion.hasRetailData && (
        <div className="mt-md rounded-md border-l-2 border-primary bg-wash p-sm">
          <div className="flex items-baseline justify-between">
            <div className="text-caption font-medium uppercase text-grey">
              Suggested prices
            </div>
            <button
              type="button"
              onClick={onApplySuggestion}
              className="inline-flex min-h-11 items-center gap-2xs text-ledger font-medium text-accent hover:underline"
            >
              <Sparkles className="h-3 w-3" strokeWidth={2} aria-hidden />
              Use these
            </button>
          </div>
          <div className="mt-xs grid grid-cols-2 gap-sm text-ledger text-grey">
            <div>
              <span className="tabular text-body-lg font-medium text-ink">
                {suggestion.suggestedGlass != null
                  ? `$${suggestion.suggestedGlass}`
                  : "—"}
              </span>
              <div className="mt-2xs text-micro text-grey">
                glass · target {Math.round(suggestion.targetPourCostPct)}% pour cost
              </div>
            </div>
            <div>
              <span className="tabular text-body-lg font-medium text-ink">
                {suggestion.suggestedBottle != null
                  ? `$${suggestion.suggestedBottle}`
                  : "—"}
              </span>
              <div className="mt-2xs text-micro text-grey">
                bottle · target {suggestion.targetMarkupRatio.toFixed(1)}× retail
              </div>
            </div>
          </div>
          <div className="mt-xs text-micro text-grey">
            Source: Wine-Searcher · {suggestion.retailRetailerCount ?? 0} retailers ·
            median ${Math.round(suggestion.retailMedian ?? 0)}
            {suggestion.categoryBandApplied && " · category band applied"}
          </div>
        </div>
      )}
      {!suggesting && suggestion && !suggestion.hasRetailData && (
        <div className="mt-md rounded-md bg-wash p-sm text-ledger italic text-grey">
          Pricing data unavailable for this wine. Refresh retail data from
          Insights to enable suggestions.
        </div>
      )}
      {suggestError && (
        <p role="alert" className="mt-sm text-ledger text-risk-ink">
          {suggestError}
        </p>
      )}

      <div className="mt-md grid grid-cols-2 gap-md">
        <PriceField
          id="add-wine-glass-price"
          label="Glass price"
          value={glassPrice}
          onChange={onGlassPriceChange}
        />
        <PriceField
          id="add-wine-bottle-price"
          label="Bottle price"
          value={bottlePrice}
          onChange={onBottlePriceChange}
        />
      </div>
    </>
  );
}

function PriceField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-xs block text-caption font-medium uppercase text-grey">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 tabular text-control text-grey">
          $
        </span>
        <input
          type="text"
          inputMode="decimal"
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="—"
          // 17px keeps iOS from zooming the page on focus; 14px once there is
          // a pointer. Both are scale tokens, unlike the 16px literal before.
          className="h-11 w-full rounded-pill border border-rule bg-surface pl-md pr-sm text-right tabular text-body-lg text-ink placeholder:text-grey focus:border-accent focus-ring md:text-control"
        />
      </div>
    </div>
  );
}
