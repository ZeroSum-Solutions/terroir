"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, RotateCcw, Clock, DollarSign } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { cn } from "@/lib/utils";

const snoozedAlertCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence(
    "terroir:wine-snoozed-alerts",
  ),
});

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
 */

export type SnoozedRow = {
  wine_id: string;
  name: string;
  producer: string;
  vintage: number | null;
  drinkWindowSnoozedUntil: string | null;
  pricingDismissedUntil: string | null;
};

export function SnoozedAlertsCard({ snoozed }: { snoozed: SnoozedRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const busyRef = useRef(new Set<string>());
  const [, startTransition] = useTransition();

  if (snoozed.length === 0) return null;

  const onUnsnooze = async (
    wineId: string,
    kind: "drink-window" | "pricing",
  ) => {
    const key = `${wineId}:${kind}`;
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy((b) => ({ ...b, [key]: true }));
    setErrorMsg(null);
    try {
      const endpoint =
        kind === "drink-window"
          ? `/api/wines/${wineId}/snooze-alert`
          : `/api/wines/${wineId}/dismiss-pricing-alert`;
      const { response, data } =
        await snoozedAlertCommands.json<unknown>({
          slot: `unsnooze:${key}`,
          url: endpoint,
          method: "POST",
          json: { days: 0 },
        });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            `Failed (${response.status}).`,
          ).message,
        );
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unsnooze failed.");
      busyRef.current.delete(key);
      setBusy((b) => ({ ...b, [key]: false }));
      startTransition(() => router.refresh());
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
    <article className="rounded-md border border-border bg-white p-md md:p-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <h3 className="font-serif text-[16px] text-ink">
            Snoozed alerts
          </h3>
          <p className="mt-2xs text-[12px] text-ink-muted">
            {entries.length} active snooze{entries.length === 1 ? "" : "s"}.
            Tap to view + unsnooze early.
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-ink-muted transition-transform",
            open && "rotate-180",
          )}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open && (
        <ul className="mt-md flex flex-col divide-y divide-border">
          {entries.map((e) => {
            const key = `${e.wineId}:${e.kind}`;
            const isBusy = busy[key] ?? false;
            const expires = formatExpires(e.until);
            return (
              <li
                key={key}
                className="flex items-center justify-between gap-md py-sm"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-serif text-[14px] text-ink">
                    {e.producer}, {e.name}
                  </span>
                  {e.vintage && (
                    <span className="ml-xs font-mono text-[11px] text-ink-tertiary">
                      {e.vintage}
                    </span>
                  )}
                  <div className="mt-2xs flex items-center gap-xs text-[11px] text-ink-muted">
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
                    <span className="text-ink-subtle">·</span>
                    <span className="font-mono">until {expires}</span>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onUnsnooze(e.wineId, e.kind)}
                  className="inline-flex h-[30px] items-center gap-2xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-bg-secondary disabled:opacity-60"
                >
                  <RotateCcw
                    className="h-3 w-3"
                    strokeWidth={2}
                    aria-hidden
                  />
                  Unsnooze
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {errorMsg && (
        <p role="alert" className="mt-sm text-[12px] text-error">
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
