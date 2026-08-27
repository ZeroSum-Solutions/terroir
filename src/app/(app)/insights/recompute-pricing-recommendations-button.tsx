"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Requester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestPricingRecommendationsRecompute(
  request: Requester = fetch,
) {
  const response = await request("/api/pricing-recommendations/recompute", {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("Pricing recommendations recompute failed");
  }
}

export function RecomputePricingRecommendationsButton({
  blockedReason,
}: {
  /** When set, the button is disabled and explains why — an enabled action
      that cannot succeed is a dead end (Kimi audit 2026-08-26). */
  blockedReason?: string;
} = {}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recompute() {
    setBusy(true);
    setError(null);
    try {
      await requestPricingRecommendationsRecompute();
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Pricing recommendations recompute failed",
      );
    } finally {
      setBusy(false);
    }
  }

  const blocked = blockedReason != null;
  return (
    <div className="flex flex-col items-end gap-2xs">
      <button
        type="button"
        onClick={recompute}
        disabled={busy || blocked}
        className="inline-flex h-11 items-center rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-60"
      >
        {busy ? "Recomputing…" : "Recompute"}
      </button>
      {blocked && <p className="text-[11px] text-grey">{blockedReason}</p>}
      {error && <p role="alert" className="text-[12px] text-accent">{error}</p>}
    </div>
  );
}
