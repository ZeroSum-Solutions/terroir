"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/api/client-error";
import { createIdempotentCommandStore } from "@/lib/api/idempotency-client";
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
  const savingRef = useRef(false);
  const [commands] = useState(() => createIdempotentCommandStore());
  const [, startTransition] = useTransition();
  const resolvedInitialPourCost =
    initialPourCost ?? DEFAULT_TARGET_POUR_COST_PCT;
  const resolvedInitialMarkup =
    initialMarkup ?? DEFAULT_TARGET_MARKUP_RATIO;
  const [serverValues, setServerValues] = useState(() => ({
    pourCostPct: resolvedInitialPourCost,
    markupRatio: resolvedInitialMarkup,
  }));
  if (
    serverValues.pourCostPct !== resolvedInitialPourCost ||
    serverValues.markupRatio !== resolvedInitialMarkup
  ) {
    setServerValues({
      pourCostPct: resolvedInitialPourCost,
      markupRatio: resolvedInitialMarkup,
    });
    setPourCostPct(resolvedInitialPourCost);
    setMarkupRatio(resolvedInitialMarkup);
  }

  const patch = async (
    slot: string,
    body: {
      default_target_pour_cost_pct?: number;
      default_target_markup_ratio?: number;
    },
  ) => {
    setError(null);
    setSaving(true);
    try {
      const { response, data } = await commands.json<unknown>({
        slot,
        url: `/api/restaurant/${restaurantId}`,
        method: "PATCH",
        json: body,
      });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            `Request failed (${response.status}).`,
          ).message,
        );
      }
      // Re-render server components so the new targets propagate to the
      // cellar drawer + insights pricing review immediately.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      startTransition(() => router.refresh());
      throw e;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const onPourCostCommit = async (value: number) => {
    if (!Number.isFinite(value) || value <= 0 || value >= 100) return;
    if (value === pourCostPct) return;
    if (savingRef.current) return;
    savingRef.current = true;
    const prev = pourCostPct;
    setPourCostPct(value);
    try {
      await patch(
        `restaurant:${restaurantId}:default_target_pour_cost_pct`,
        { default_target_pour_cost_pct: value },
      );
    } catch {
      setPourCostPct(prev);
    }
  };

  const onMarkupCommit = async (value: number) => {
    if (!Number.isFinite(value) || value < 1 || value > 10) return;
    if (value === markupRatio) return;
    if (savingRef.current) return;
    savingRef.current = true;
    const prev = markupRatio;
    setMarkupRatio(value);
    try {
      await patch(
        `restaurant:${restaurantId}:default_target_markup_ratio`,
        { default_target_markup_ratio: value },
      );
    } catch {
      setMarkupRatio(prev);
    }
  };

  return (
    <section
      aria-labelledby="pricing-targets-heading"
      className="rounded-md border border-border bg-white p-md md:p-lg"
    >
      <div className="mb-md">
        <h2
          id="pricing-targets-heading"
          className="font-serif text-[16px] text-ink"
        >
          House pricing targets
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          Drives every pricing recommendation in the app. Each wine can
          still override these in the wine-detail drawer (allocation wines
          like Krug typically use a lower markup than the house default).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-md md:grid-cols-2">
        <label className="flex flex-col gap-xs">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            Glass pour cost target
          </span>
          <div className="flex items-center gap-xs">
            <input
              key={pourCostPct}
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
              className="h-[34px] w-[80px] rounded-sm border border-border bg-white px-sm text-right font-mono text-[14px]"
            />
            <span className="text-[12px] text-ink-muted">%</span>
            <span className="ml-xs text-[11px] text-ink-tertiary">
              industry typical 18–25%
            </span>
          </div>
        </label>

        <label className="flex flex-col gap-xs">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            Bottle markup target
          </span>
          <div className="flex items-center gap-xs">
            <input
              key={markupRatio}
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
              className="h-[34px] w-[80px] rounded-sm border border-border bg-white px-sm text-right font-mono text-[14px]"
            />
            <span className="text-[12px] text-ink-muted">× retail</span>
            <span className="ml-xs text-[11px] text-ink-tertiary">
              fine-dining typical 2.5–3.0×
            </span>
          </div>
        </label>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            "mt-md rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger",
          )}
        >
          {error}
        </div>
      )}

      <p className="mt-md border-t border-border pt-sm text-[11px] italic text-ink-tertiary">
        Changes save on blur or Enter. Targets apply across Insights pricing
        review, Cellar drawer pricing section, and the AddWineModal price
        suggestions.
      </p>
    </section>
  );
}
