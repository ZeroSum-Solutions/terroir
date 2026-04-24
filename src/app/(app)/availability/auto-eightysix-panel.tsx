"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

const ML_PER_OZ = 29.5735;

interface Props {
  restaurantId: string;
  enabled: boolean;
  thresholdMl: number;
}

/**
 * BND-037b: owner-only panel on /availability that toggles auto-86
 * on low inventory and lets the owner tune the threshold. PATCHes
 * /api/restaurant/[id] with whichever field(s) changed.
 *
 * Optimistic UX: flip local state immediately; revert on error. No
 * router.refresh() because the panel's state is self-contained —
 * toggling doesn't change what wines render in the list below.
 */
export function AutoEightysixPanel({
  restaurantId,
  enabled: initialEnabled,
  thresholdMl: initialThreshold,
}: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [thresholdMl, setThresholdMl] = useState(initialThreshold);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  const patch = async (body: {
    auto_eightysix_from_inventory?: boolean;
    eightysix_ml_threshold?: number;
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
      // Re-render server component so revalidated auto-86s land in the list.
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

  return (
    <section
      aria-labelledby="auto86-heading"
      className="mb-lg rounded-md border border-border bg-white p-md md:p-lg"
    >
      <div className="flex flex-col gap-sm md:flex-row md:items-start md:justify-between md:gap-lg">
        <div className="min-w-0">
          <h2
            id="auto86-heading"
            className="font-serif text-[16px] text-ink"
          >
            Auto-86 on low inventory
          </h2>
          <p className="mt-xs text-[13px] text-ink-muted">
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
            className="h-5 w-5 rounded-sm border-border"
          />
          <span>{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      {enabled && (
        <div className="mt-md flex flex-wrap items-center gap-sm border-t border-border/60 pt-md">
          <label className="flex items-center gap-xs text-[13px] text-ink-muted">
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
              className="ml-xs h-[32px] w-[80px] rounded-sm border border-border bg-white px-sm text-right font-mono text-[13px]"
            />
            <span className="text-[11px] text-ink-subtle">ml</span>
            <span className="text-[11px] text-ink-subtle">
              ≈ {(thresholdMl / ML_PER_OZ).toFixed(1)} oz
            </span>
          </label>
          <p className="text-[12px] text-ink-subtle">
            Default is one 5 oz glass pour (148 ml).
          </p>
        </div>
      )}

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
    </section>
  );
}
