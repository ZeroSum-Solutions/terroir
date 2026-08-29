"use client";

export default function ReconciliationQueueError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="rounded-md border border-risk-ink/30 bg-risk-wash p-md text-[13px] text-risk-ink">
      <p>Reconciliation queue could not be loaded.</p>
      <button type="button" onClick={reset} className="mt-sm h-11 rounded-pill border border-accent/30 bg-surface px-md font-medium hover:bg-wash focus-ring">Try again</button>
    </section>
  );
}
