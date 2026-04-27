"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatPricingStatusLabel,
  type PricingStatus,
} from "@/lib/pricing/status";
import type { PricingAlertRow } from "@/lib/pricing/alerts";

/**
 * BND-040 — PricingReviewCard
 *
 * Sits in the Insights briefing alongside the Drink-window watch (BND-039).
 * Renders only when ≥1 wine deviates from user-set targets after snooze
 * filter. Outliers only — no dollar-amount headlines.
 *
 * Trust language locked:
 *   • Headline: "{N} wines off your targets · worth a review when ready"
 *   • Per-row reason: small print "tight margin · drink window closes 4 yrs"
 *   • Actions: View bottles deep-link, Quick adjust → list editor, Snooze 30d
 *   • No "$X opportunity" framing — fine dining is calm
 */

export function PricingReviewCard({
  alerts,
  firstName,
}: {
  alerts: PricingAlertRow[];
  firstName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (alerts.length === 0) return null;

  const onSnooze = async (wineId: string) => {
    setBusy((b) => ({ ...b, [wineId]: true }));
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/wines/${wineId}/dismiss-pricing-alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30 }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Failed (${res.status}).`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Snooze failed.");
      setBusy((b) => ({ ...b, [wineId]: false }));
    }
  };

  const tightCount = alerts.filter(
    (a) => a.bottleStatus === "tight" || a.glassStatus === "tight",
  ).length;
  const outlierCount = alerts.filter(
    (a) => a.bottleStatus === "outlier" || a.glassStatus === "outlier",
  ).length;

  return (
    <article
      className={cn(
        "rounded-md border border-border bg-white p-md md:p-lg",
        "border-l-[3px] border-l-warning",
      )}
    >
      <h3 className="font-serif text-[18px] text-ink md:text-[20px]">
        {firstName !== "there" ? `Hey ${firstName} — ` : ""}
        {alerts.length} wine{alerts.length === 1 ? "" : "s"} off your pricing targets
      </h3>
      <p className="mt-xs text-[12px] text-ink-muted">
        Worth a review when ready
        {outlierCount > 0 && (
          <>
            {" "}
            · <span className="font-mono">{outlierCount}</span> outlier
            {outlierCount === 1 ? "" : "s"}
          </>
        )}
        {tightCount > 0 && (
          <>
            {" "}
            · <span className="font-mono">{tightCount}</span> tight margin
            {tightCount === 1 ? "" : "s"}
          </>
        )}
      </p>

      <ul className="mt-md flex flex-col divide-y divide-border">
        {alerts.slice(0, 5).map((alert) => (
          <PricingReviewRow
            key={alert.wine_list_item_id}
            alert={alert}
            busy={busy[alert.wine_id] ?? false}
            onSnooze={() => onSnooze(alert.wine_id)}
          />
        ))}
      </ul>

      {alerts.length > 5 && (
        <p className="mt-sm text-[12px] text-ink-muted">
          + {alerts.length - 5} more — view full pricing review →
        </p>
      )}

      {errorMsg && (
        <p role="alert" className="mt-sm text-[12px] text-error">
          {errorMsg}
        </p>
      )}

      <p className="mt-md border-t border-border pt-md text-[11px] italic text-ink-tertiary">
        Heuristic — based on your house targets + category bands. Velocity-driven
        recommendations available after 12 weeks of pour data.
      </p>
    </article>
  );
}

function PricingReviewRow({
  alert,
  busy,
  onSnooze,
}: {
  alert: PricingAlertRow;
  busy: boolean;
  onSnooze: () => void;
}) {
  // Build the reason string from status fields. Multiple triggers
  // chained with ·.
  const reasons: string[] = [];
  if (alert.glassStatus === "tight" || alert.glassStatus === "outlier") {
    reasons.push(
      `${formatPricingStatusLabel(alert.glassStatus).toLowerCase()} on glass`,
    );
  }
  if (alert.bottleStatus === "tight" || alert.bottleStatus === "outlier") {
    reasons.push(
      `${formatPricingStatusLabel(alert.bottleStatus).toLowerCase()} on bottle`,
    );
  }
  if (alert.bottleStatus === "premium" || alert.glassStatus === "premium") {
    reasons.push("above target");
  }

  const ratioDisplay = formatRatioDisplay(alert);

  return (
    <li className="flex items-center justify-between gap-md py-sm">
      <div className="min-w-0 flex-1">
        <span className="font-serif text-[14px] text-ink">
          {alert.producer}, {alert.name}
        </span>
        {alert.vintage && (
          <span className="ml-xs font-mono text-[11px] text-ink-tertiary">
            {alert.vintage}
          </span>
        )}
        <span className="block text-[11px] text-ink-muted md:inline md:ml-xs">
          {reasons.length > 0 && `· ${reasons.join(" · ")}`}
        </span>
      </div>
      <div className="flex items-center gap-xs">
        <span className="hidden font-mono text-[12px] text-ink-tertiary md:inline">
          {ratioDisplay}
        </span>
        <Link
          href={`/cellar?wine=${alert.wine_id}`}
          className="inline-flex h-[30px] items-center gap-2xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-bg-secondary"
        >
          Review
          <ChevronRight className="h-3 w-3" strokeWidth={2} aria-hidden />
        </Link>
        <button
          type="button"
          onClick={onSnooze}
          disabled={busy}
          aria-label="Snooze 30 days"
          className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-sm text-ink-muted hover:bg-bg-secondary disabled:opacity-60"
        >
          <X className="h-3 w-3" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </li>
  );
}

function formatRatioDisplay(alert: PricingAlertRow): string {
  const parts: string[] = [];
  if (alert.markupRatio != null) {
    parts.push(`${alert.markupRatio.toFixed(1)}× / ${alert.targetMarkupRatio.toFixed(1)}×`);
  }
  if (alert.pourCostPct != null) {
    parts.push(
      `${Math.round(alert.pourCostPct)}% / ${Math.round(alert.targetPourCostPct)}%`,
    );
  }
  return parts.join(" · ");
}

// Re-export for convenience so insights/page.tsx can keep both alert types
// imported from a single location.
export type { PricingStatus };
