"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, RotateCcw } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import { cn } from "@/lib/utils";

/**
 * BND-040 follow-up — per-wine pricing target override (in cellar drawer).
 *
 * Allocation wines (Krug 1.8×, DRC 1.5×) typically deviate from the
 * house default. This component lives inside the drawer's Pricing
 * section as a collapsed-by-default expander.
 *
 * When expanded:
 *   • Two inputs: pour cost % and markup × ratio
 *   • Each input shows current effective value (per-wine override OR
 *     restaurant default) as the placeholder
 *   • "Use house defaults" button clears both overrides
 *   • Owner+manager only (parent gates)
 *
 * On commit (blur or Enter):
 *   PATCH /api/wines/[id]/pricing-targets { pour_cost_pct, markup_ratio }
 *   Empty input → null → clears the override.
 *
 * Optimistic UI with revert on error. Refresh propagates the new
 * effective targets to the rest of the drawer + Insights pricing review.
 */

interface Props {
  wineId: string;
  /** Current per-wine override for pour cost % (null = inherits house). */
  perWinePourCostPct: number | null;
  /** Current per-wine override for markup ratio (null = inherits house). */
  perWineMarkupRatio: number | null;
  /** House default — shown as fallback hint when no per-wine override set. */
  housePourCostPct: number;
  /** House default — shown as fallback hint when no per-wine override set. */
  houseMarkupRatio: number;
}

export function PricingTargetOverride({
  wineId,
  perWinePourCostPct,
  perWineMarkupRatio,
  housePourCostPct,
  houseMarkupRatio,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pourCost, setPourCost] = useState(
    perWinePourCostPct?.toString() ?? "",
  );
  const [markup, setMarkup] = useState(
    perWineMarkupRatio?.toString() ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const hasOverride = perWinePourCostPct != null || perWineMarkupRatio != null;

  const patch = async (body: {
    pour_cost_pct?: number | null;
    markup_ratio?: number | null;
  }) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/wines/${wineId}/pricing-targets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(
          readApiError(
            await res.json().catch(() => null),
            `Save failed (${res.status}).`,
          ).message,
        );
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const onPourCostCommit = async (raw: string) => {
    const trimmed = raw.trim();
    // Empty / cleared → null (revert to house default).
    if (trimmed === "") {
      if (perWinePourCostPct == null) return; // already cleared
      try {
        await patch({ pour_cost_pct: null });
      } catch {
        setPourCost(perWinePourCostPct?.toString() ?? "");
      }
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
      setError("Pour cost must be between 0 and 100.");
      setPourCost(perWinePourCostPct?.toString() ?? "");
      return;
    }
    if (value === perWinePourCostPct) return;
    try {
      await patch({ pour_cost_pct: value });
    } catch {
      setPourCost(perWinePourCostPct?.toString() ?? "");
    }
  };

  const onMarkupCommit = async (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      if (perWineMarkupRatio == null) return;
      try {
        await patch({ markup_ratio: null });
      } catch {
        setMarkup(perWineMarkupRatio?.toString() ?? "");
      }
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 1 || value > 10) {
      setError("Markup ratio must be between 1 and 10.");
      setMarkup(perWineMarkupRatio?.toString() ?? "");
      return;
    }
    if (value === perWineMarkupRatio) return;
    try {
      await patch({ markup_ratio: value });
    } catch {
      setMarkup(perWineMarkupRatio?.toString() ?? "");
    }
  };

  const onResetToHouse = async () => {
    if (!hasOverride) return;
    try {
      await patch({ pour_cost_pct: null, markup_ratio: null });
      setPourCost("");
      setMarkup("");
    } catch {
      // patch sets error; inputs stay as-is so user can retry
    }
  };

  return (
    <div className="mt-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-sm px-2xs py-2xs text-[12px] font-medium text-ink-muted hover:bg-bg-secondary"
      >
        <span>
          {hasOverride
            ? "Custom targets for this wine"
            : "Override targets for this wine"}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform",
            open && "rotate-180",
          )}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open && (
        <div className="mt-xs rounded-sm border border-border bg-bg-secondary p-sm">
          <div className="grid grid-cols-2 gap-sm">
            <label className="flex flex-col gap-2xs">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                Pour cost %
              </span>
              <div className="flex items-center gap-2xs">
                <input
                  type="number"
                  min={1}
                  max={99}
                  step={0.5}
                  value={pourCost}
                  placeholder={`${housePourCostPct}`}
                  disabled={busy}
                  onChange={(e) => setPourCost(e.target.value)}
                  onBlur={(e) => void onPourCostCommit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      (e.target as HTMLInputElement).blur();
                  }}
                  aria-label="Per-wine pour cost target"
                  className="h-[30px] w-full rounded-sm border border-border bg-white px-xs text-right font-mono text-[13px]"
                />
                <span className="text-[11px] text-ink-tertiary">%</span>
              </div>
              <span className="text-[10px] text-ink-tertiary">
                house: {housePourCostPct}%
              </span>
            </label>

            <label className="flex flex-col gap-2xs">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                Markup
              </span>
              <div className="flex items-center gap-2xs">
                <input
                  type="number"
                  min={1}
                  max={10}
                  step={0.1}
                  value={markup}
                  placeholder={`${houseMarkupRatio}`}
                  disabled={busy}
                  onChange={(e) => setMarkup(e.target.value)}
                  onBlur={(e) => void onMarkupCommit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      (e.target as HTMLInputElement).blur();
                  }}
                  aria-label="Per-wine markup ratio target"
                  className="h-[30px] w-full rounded-sm border border-border bg-white px-xs text-right font-mono text-[13px]"
                />
                <span className="text-[11px] text-ink-tertiary">×</span>
              </div>
              <span className="text-[10px] text-ink-tertiary">
                house: {houseMarkupRatio.toFixed(1)}×
              </span>
            </label>
          </div>

          {hasOverride && (
            <button
              type="button"
              onClick={() => void onResetToHouse()}
              disabled={busy}
              className="mt-sm inline-flex items-center gap-2xs text-[11px] font-medium text-ink-muted hover:text-ink disabled:opacity-60"
            >
              <RotateCcw className="h-3 w-3" strokeWidth={2} aria-hidden />
              Use house defaults
            </button>
          )}

          {error && (
            <p
              role="alert"
              className="mt-xs text-[11px] text-error"
            >
              {error}
            </p>
          )}

          <p className="mt-xs text-[10px] italic text-ink-tertiary">
            Useful for allocation wines (Champagne, grower Burgundy) that
            deviate from the house default. Save on blur or Enter.
          </p>
        </div>
      )}
    </div>
  );
}
