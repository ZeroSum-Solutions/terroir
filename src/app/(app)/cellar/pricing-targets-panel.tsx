"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TARGET_MARKUP_RATIO,
  DEFAULT_TARGET_POUR_COST_PCT,
} from "@/lib/pricing/status";

interface Props {
  restaurantId: string;
  pourCostPct: number | null;
  markupRatio: number | null;
}

/**
 * BND-040 follow-up — owner-only pricing targets panel.
 *
 * Lives in the Cellar settings modal alongside the auto-86 panel. Lets
 * the owner set the house defaults that drive every pricing
 * recommendation — pour cost % target (default 22%) and bottle markup
 * × target (default 2.7×). Per-wine overrides on `wines.pricing_target_*`
 * still win for allocation wines (Krug 1.8× etc.) — those are managed
 * from the cellar drawer.
 *
 * Optimistic local state with on-blur PATCH to /api/restaurant/[id].
 * Mirrors AutoEightysixPanel's pattern so the two panels feel uniform
 * inside the settings modal.
 */
export function PricingTargetsPanel({
  restaurantId,
  pourCostPct: initialPourCost,
  markupRatio: initialMarkup,
}: Props) {
  const router = useRouter();
  const [pourCostPct, setPourCostPct] = useState(
    initialPourCost ?? DEFAULT_TARGET_POUR_COST_PCT,
  );
  const [markupRatio, setMarkupRatio] = useState(
    initialMarkup ?? DEFAULT_TARGET_MARKUP_RATIO,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  const patch = async (body: {
    default_target_pour_cost_pct?: number;
    default_target_markup_ratio?: number;
  }) => {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Request failed (${res.status}).`);
      }
      // Re-render server components so the new targets propagate to the
      // cellar drawer + insights pricing review immediately.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const onPourCostCommit = async (value: number) => {
    if (!Number.isFinite(value) || value <= 0 || value >= 100) return;
    if (value === pourCostPct) return;
    const prev = pourCostPct;
    setPourCostPct(value);
    try {
      await patch({ default_target_pour_cost_pct: value });
    } catch {
      setPourCostPct(prev);
    }
  };

  const onMarkupCommit = async (value: number) => {
    if (!Number.isFinite(value) || value < 1 || value > 10) return;
    if (value === markupRatio) return;
    const prev = markupRatio;
    setMarkupRatio(value);
    try {
      await patch({ default_target_markup_ratio: value });
    } catch {
      setMarkupRatio(prev);
    }
  };

  return (
    <section
      aria-labelledby="pricing-targets-heading"
      className="rounded-lg card-surface p-md md:p-lg"
    >
      <div className="mb-md">
        <h2
          id="pricing-targets-heading"
          className="font-serif text-[16px] font-medium text-ink"
        >
          House pricing targets
        </h2>
        <p className="mt-xs text-[13px] text-grey">
          Drives every pricing recommendation in the app. Each wine can
          still override these in the wine-detail drawer (allocation wines
          like Krug typically use a lower markup than the house default).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-md md:grid-cols-2">
        <label className="flex flex-col gap-xs">
          <span className="text-caption font-medium uppercase text-grey">
            Glass pour cost target
          </span>
          <div className="flex items-center gap-xs">
            <input
              type="number"
              min={1}
              max={99}
              step={0.5}
              defaultValue={pourCostPct}
              disabled={saving}
              onBlur={(e) => void onPourCostCommit(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              aria-label="Glass pour cost percentage target"
              className="h-[34px] w-[80px] rounded-pill border border-hairline bg-surface px-sm text-right font-mono text-[14px]"
            />
            <span className="text-[12px] text-grey">%</span>
            <span className="ml-xs text-[11px] text-grey">
              industry typical 18–25%
            </span>
          </div>
        </label>

        <label className="flex flex-col gap-xs">
          <span className="text-caption font-medium uppercase text-grey">
            Bottle markup target
          </span>
          <div className="flex items-center gap-xs">
            <input
              type="number"
              min={1}
              max={10}
              step={0.1}
              defaultValue={markupRatio}
              disabled={saving}
              onBlur={(e) => void onMarkupCommit(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              aria-label="Bottle markup ratio target"
              className="h-[34px] w-[80px] rounded-pill border border-hairline bg-surface px-sm text-right font-mono text-[14px]"
            />
            <span className="text-[12px] text-grey">× retail</span>
            <span className="ml-xs text-[11px] text-grey">
              fine-dining typical 2.5–3.0×
            </span>
          </div>
        </label>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            "mt-md rounded-md border border-accent/30 bg-blush-wash px-md py-sm text-[13px] text-accent",
          )}
        >
          {error}
        </div>
      )}

      <p className="mt-md border-t border-hairline pt-sm text-[11px] italic text-grey">
        Changes save on blur or Enter. Targets apply across Insights pricing
        review, Cellar drawer pricing section, and the AddWineModal price
        suggestions.
      </p>
    </section>
  );
}
