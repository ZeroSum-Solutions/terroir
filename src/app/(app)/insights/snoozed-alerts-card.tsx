"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, RotateCcw, Clock, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { metricHref } from "./metric-href";
import type { SnoozedRow } from "@/domains/cellar/snoozed-alerts";
import { wineTitle } from "@/lib/wine-display-name";

/**
 * BND-040 follow-up — SnoozedAlertsCard
 *
 * Surfaces all currently-snoozed alerts (drink-window + pricing) so
 * operators can unsnooze early. Lives at the bottom of the Insights
 * briefing as a collapsed-by-default expander; opens to a table of
 * (wine, type, expires, unsnooze) rows.
 *
 * Audit-finding M2: previously, once a sommelier hit Snooze 30d, the
 * alert vanished and there was no way to bring it back early. This
 * closes the gap.
 *
 * SD-24: unsnoozing POSTs to the same two owner/manager routes the snooze
 * does, so the Unsnooze control is rendered only for `canManage`. What is
 * snoozed stays visible to every member.
 */

export type { SnoozedRow };

export function SnoozedAlertsCard({
  snoozed,
  canManage,
}: {
  snoozed: SnoozedRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (snoozed.length === 0) return null;

  const onUnsnooze = async (
    wineId: string,
    kind: "drink-window" | "pricing",
  ) => {
    const key = `${wineId}:${kind}`;
    setBusy((b) => ({ ...b, [key]: true }));
    setErrorMsg(null);
    try {
      const endpoint =
        kind === "drink-window"
          ? `/api/wines/${wineId}/snooze-alert`
          : `/api/wines/${wineId}/dismiss-pricing-alert`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 0 }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `Failed (${res.status}).`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unsnooze failed.");
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  // Each row may have one or two snoozes. Flatten so each
  // (wine, kind) pair is a separate entry — easier UX for unsnooze
  // because each row is a single action.
  const entries: Array<{
    wineId: string;
    name: string;
    producer: string;
    vintage: number | null;
    kind: "drink-window" | "pricing";
    until: string;
  }> = [];
  for (const w of snoozed) {
    if (w.drinkWindowSnoozedUntil) {
      entries.push({
        wineId: w.wine_id,
        name: w.name,
        producer: w.producer,
        vintage: w.vintage,
        kind: "drink-window",
        until: w.drinkWindowSnoozedUntil,
      });
    }
    if (w.pricingDismissedUntil) {
      entries.push({
        wineId: w.wine_id,
        name: w.name,
        producer: w.producer,
        vintage: w.vintage,
        kind: "pricing",
        until: w.pricingDismissedUntil,
      });
    }
  }

  return (
    <article className="rounded-card card-surface p-md md:p-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-sm text-left focus-ring"
      >
        <div>
          <h3 className="font-serif text-[18px] text-ink">
            Snoozed alerts
          </h3>
          <p className="mt-2xs text-[12px] text-grey">
            {entries.length} active snooze{entries.length === 1 ? "" : "s"}.
            Tap to view + unsnooze early.
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-grey transition-transform",
            open && "rotate-180",
          )}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open && (
        <ul className="mt-md flex flex-col divide-y divide-rule">
          {entries.map((e) => {
            const key = `${e.wineId}:${e.kind}`;
            const isBusy = busy[key] ?? false;
            const expires = formatExpires(e.until);
            return (
              <li
                key={key}
                data-metric={`snoozed-${e.kind}-${e.wineId}`}
                className="flex items-center justify-between gap-md py-sm"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={metricHref("wine", e.wineId)}
                    className="font-serif text-[17px] font-medium text-ink transition-colors hover:text-accent"
                  >
                    {wineTitle(e.producer, e.name, ", ")}
                  </Link>
                  {e.vintage && (
                    <span className="ml-xs text-[11px] font-light text-grey">
                      {e.vintage}
                    </span>
                  )}
                  <div className="mt-2xs flex items-center gap-xs text-[11px] text-grey">
                    {e.kind === "drink-window" ? (
                      <>
                        <Clock
                          className="h-3 w-3"
                          strokeWidth={2}
                          aria-hidden
                        />
                        <span>Drink-window alert</span>
                      </>
                    ) : (
                      <>
                        <DollarSign
                          className="h-3 w-3"
                          strokeWidth={2}
                          aria-hidden
                        />
                        <span>Pricing review</span>
                      </>
                    )}
                    <span className="text-grey">·</span>
                    <span className="tabular">until {expires}</span>
                  </div>
                </div>
                {canManage && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onUnsnooze(e.wineId, e.kind)}
                    className="inline-flex min-h-11 items-center gap-2xs rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring disabled:opacity-60"
                  >
                    <RotateCcw
                      className="h-3 w-3"
                      strokeWidth={2}
                      aria-hidden
                    />
                    Unsnooze
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {errorMsg && (
        <p role="alert" className="mt-sm text-[12px] text-risk-ink">
          {errorMsg}
        </p>
      )}
    </article>
  );
}

function formatExpires(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays < 7) return `${diffDays} days`;
  return date.toLocaleDateString();
}
