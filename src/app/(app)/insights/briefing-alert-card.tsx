"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DrinkWindowTimeline } from "@/components/drink-window-timeline";
import { getYearsUntilWindowClose } from "@/lib/drink-window/status";
import type { DrinkWindowAlertRow } from "@/lib/drink-window/alerts";
import { metricHref } from "./metric-href";

/**
 * BND-039 — BriefingAlertCard
 *
 * One card per wine entering its final drinking window. Sits at the top
 * of the Insights briefing. Personalised headline names the operator
 * (first name from email) so the alert reads as a message, not a metric.
 *
 * Architecture: this is a client component because Snooze is interactive
 * (POST + revalidation). The parent server component fetches the alerts
 * list and passes it as `alerts` prop.
 *
 * Actions:
 *   • View bottles → deep-link to /cellar?wine={id} (Cellar opens drawer)
 *   • Add to menu → disabled stub for v1.5 (the menu-pairing feature)
 *   • Add to staff briefing → disabled stub for v1.5
 *   • Snooze 30 days → POST /api/wines/{id}/snooze-alert + refresh
 */

// Type re-export for back-compat. The canonical shape lives in
// @/lib/drink-window/alerts (DrinkWindowAlertRow) and is the same here.
export type DrinkWindowAlert = DrinkWindowAlertRow;

export function BriefingAlertCard({
  alert,
  firstName,
}: {
  alert: DrinkWindowAlert;
  firstName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const yearsLeft = getYearsUntilWindowClose(alert.drink_window_end);
  const yearsLabel =
    yearsLeft == null
      ? "—"
      : yearsLeft <= 0
        ? "in final year"
        : `${yearsLeft} yr${yearsLeft === 1 ? "" : "s"}`;

  const onSnooze = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/wines/${alert.wine_id}/snooze-alert`, {
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
      // router.refresh re-runs the server component which re-fetches
      // alerts; the snoozed wine drops out automatically.
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Snooze failed.");
      setBusy(false);
    }
  };

  return (
    <article
      data-metric={`drink-window-${alert.wine_id}`}
      className={cn(
        "rounded-md border border-border bg-white p-md md:p-lg",
        "border-l-[3px] border-l-warning",
      )}
    >
      <div className="flex flex-col gap-md md:flex-row md:items-start md:gap-lg">
        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-[18px] text-ink md:text-[20px]">
            Hey {firstName} — {alert.bottle_count} bottle{alert.bottle_count === 1 ? "" : "s"} of{" "}
            <em className="font-semibold italic">
              {alert.producer}, {alert.name}
              {alert.vintage ? ` ${alert.vintage}` : ""}
            </em>{" "}
            {alert.bottle_count === 1 ? "is" : "are"} entering {alert.bottle_count === 1 ? "its" : "their"} final drinking window.
          </h3>
          <div className="mt-xs flex flex-wrap items-center gap-sm text-[12px] text-ink-muted">
            <span className="inline-flex items-center gap-2xs">
              <Clock className="h-3 w-3" strokeWidth={2} aria-hidden />
              <span className="font-mono">~{yearsLabel}</span> remaining of optimal
            </span>
            {alert.rating != null && alert.rating_source && (
              <span>
                · last reviewed <span className="font-mono">{alert.rating} pts</span>
              </span>
            )}
            {alert.bin_location && (
              <span>
                · bin <span className="font-mono">{alert.bin_location}</span>
              </span>
            )}
          </div>
          {alert.review_excerpt && (
            <p className="mt-sm font-serif text-[14px] italic text-ink leading-snug">
              &ldquo;{alert.review_excerpt}&rdquo;
            </p>
          )}

          <div className="mt-md flex flex-wrap items-center gap-xs">
            <Link
              href={metricHref("wine", alert.wine_id)}
              className="inline-flex h-[38px] items-center gap-xs rounded-sm bg-accent px-md text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              View {alert.bottle_count} bottle{alert.bottle_count === 1 ? "" : "s"}
              <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Link>
            <button
              type="button"
              disabled
              title="Menu pairing flow ships in v1.5"
              className="h-[38px] rounded-sm border border-border bg-bg-tertiary px-md text-[13px] font-medium text-ink-subtle"
            >
              Add to menu
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onSnooze}
              className={cn(
                "inline-flex h-[38px] items-center gap-xs rounded-sm px-md text-[13px] font-medium text-ink-muted hover:bg-bg-secondary disabled:opacity-60",
              )}
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
              {busy ? "Snoozing…" : "Snooze 30 days"}
            </button>
          </div>

          {errorMsg && (
            <p role="alert" className="mt-sm text-[12px] text-error">
              {errorMsg}
            </p>
          )}
        </div>

        {/* Timeline — full size on desktop, mini on mobile */}
        <div className="md:w-[320px] md:shrink-0">
          <DrinkWindowTimeline
            start={alert.drink_window_start}
            end={alert.drink_window_end}
            size="full"
          />
          <p className="mt-xs text-[11px] italic text-ink-subtle">
            Source: {formatRatingSourceLabel(alert.rating_source)}
            {alert.rating_source === "claude_inference" && " (estimated)"}
          </p>
        </div>
      </div>
    </article>
  );
}

function formatRatingSourceLabel(source: string | null): string {
  switch (source) {
    case "rule_engine":
      return "Rule engine estimate";
    case "claude_inference":
      return "Claude AI";
    case "vinous":
      return "Vinous (Galloni)";
    case "parker":
      return "Wine Advocate";
    case "js":
      return "James Suckling";
    case "wine_spectator":
      return "Wine Spectator";
    case "decanter":
      return "Decanter";
    case "aggregate":
      return "Multiple critics";
    default:
      return "Unknown";
  }
}
