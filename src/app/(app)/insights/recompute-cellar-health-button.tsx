"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Requester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function requestCellarHealthRecompute(
  request: Requester = fetch,
) {
  const response = await request("/api/cellar-health/recompute", {
    method: "POST",
  });
  if (!response.ok) throw new Error("Cellar health recompute failed");
}

export function RecomputeCellarHealthButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recompute() {
    setBusy(true);
    setError(null);
    try {
      await requestCellarHealthRecompute();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cellar health recompute failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2xs">
      <button
        type="button"
        onClick={recompute}
        disabled={busy}
        className="inline-flex h-11 items-center rounded-pill border border-ink/25 bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Recomputing…" : "Recompute"}
      </button>
      {error && <p role="alert" className="text-[12px] text-accent">{error}</p>}
    </div>
  );
}
