"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { ML_PER_OZ } from "@/lib/units";

interface Props {
  restaurantId: string;
  enabled: boolean;
  thresholdMl: number;
  eightysixStrategy: "hide" | "mark";
}

/**
 * BND-037b + BND-173: owner-only panel on /cellar that toggles auto-86
 * on low inventory, tunes the threshold, and sets the 86 display strategy
 * (hide vs mark) for public wine lists. PATCHes /api/restaurant/[id] with
 * whichever field(s) changed.
 *
 * Optimistic UX: flip local state immediately; revert on error. No
 * router.refresh() because the panel's state is self-contained —
 * toggling doesn't change what wines render in the list below.
 */
export function AutoEightysixPanel({
  restaurantId,
  enabled: initialEnabled,
  thresholdMl: initialThreshold,
  eightysixStrategy: initialStrategy,
}: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [thresholdMl, setThresholdMl] = useState(initialThreshold);
  const [eightysixStrategy, setEightysixStrategy] = useState(initialStrategy);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  const patch = async (body: {
    auto_eightysix_from_inventory?: boolean;
    eightysix_ml_threshold?: number;
    eightysix_strategy?: "hide" | "mark";
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
      // Re-render server component so revalidated auto-86s land in the list
      // and public lists reflect the strategy change.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    try {
      await patch({ auto_eightysix_from_inventory: next });
    } catch {
      setEnabled(prev); // revert
    }
  };

  // Threshold commits on blur. Live-editing the number input would
  // issue a PATCH per keystroke.
  const onThresholdCommit = async (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value === thresholdMl) return;
    const prev = thresholdMl;
    setThresholdMl(value);
    try {
      await patch({ eightysix_ml_threshold: value });
    } catch {
      setThresholdMl(prev); // revert
    }
  };

  const onStrategyChange = async (next: "hide" | "mark") => {
    const prev = eightysixStrategy;
    setEightysixStrategy(next);
    try {
      await patch({ eightysix_strategy: next });
    } catch {
      setEightysixStrategy(prev); // revert
    }
  };

  return (
    <section
      aria-labelledby="auto86-heading"
      className="mb-lg rounded-card card-surface p-md md:p-lg"
    >
      <div className="flex flex-col gap-sm md:flex-row md:items-start md:justify-between md:gap-lg">
        <div className="min-w-0">
          <h2
            id="auto86-heading"
            className="font-serif text-[16px] font-medium text-ink"
          >
            Auto-86 on low inventory
          </h2>
          <p className="mt-xs text-[13px] text-grey">
            Automatically 86 a wine when its total remaining (open bottle +
            sealed stock) drops below the threshold. Manual restore always
            stays available.
          </p>
        </div>

        <label className="flex shrink-0 items-center gap-sm text-[13px] font-medium text-ink">
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={saving}
            onChange={(e) => void onToggle(e.target.checked)}
            className="h-5 w-5 rounded-sm border-rule"
          />
          <span>{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      {enabled && (
        <div className="mt-md flex flex-wrap items-center gap-sm border-t border-rule pt-md">
          <label className="flex items-center gap-xs text-[13px] text-grey">
            Threshold
            <input
              type="number"
              min={0}
              max={5000}
              defaultValue={thresholdMl}
              disabled={saving}
              onBlur={(e) => void onThresholdCommit(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="ml-xs h-[32px] w-[80px] rounded-pill border border-rule bg-surface px-sm text-right font-mono text-[13px]"
            />
            <span className="text-[11px] text-grey">ml</span>
            <span className="text-[11px] text-grey">
              ≈ {(thresholdMl / ML_PER_OZ).toFixed(1)} oz
            </span>
          </label>
          <p className="text-[12px] text-grey">
            Default is one 5 oz glass pour (148 ml).
          </p>
        </div>
      )}

      {/* BND-173: 86 display strategy on public wine lists */}
      <div className="mt-md border-t border-rule pt-md">
        <h3 className="font-serif text-[14px] font-medium text-ink">
          86&rsquo;d wine display on public lists
        </h3>
        <p className="mt-xs text-[13px] text-grey">
          When a wine is 86&rsquo;d, choose whether to hide it entirely
          or show it grayed out with a strikethrough on published wine
          lists.
        </p>
        <fieldset className="mt-sm flex gap-md" disabled={saving}>
          <label className="flex items-center gap-xs text-[13px] text-ink">
            <input
              type="radio"
              name="eightysix_strategy"
              value="hide"
              checked={eightysixStrategy === "hide"}
              onChange={() => void onStrategyChange("hide")}
              className="h-4 w-4"
            />
            Hide
          </label>
          <label className="flex items-center gap-xs text-[13px] text-ink">
            <input
              type="radio"
              name="eightysix_strategy"
              value="mark"
              checked={eightysixStrategy === "mark"}
              onChange={() => void onStrategyChange("mark")}
              className="h-4 w-4"
            />
            Mark gray
          </label>
        </fieldset>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            "mt-md rounded-md border border-risk-ink/30 bg-risk-wash px-md py-sm text-[13px] text-risk-ink",
          )}
        >
          {error}
        </div>
      )}
    </section>
  );
}
