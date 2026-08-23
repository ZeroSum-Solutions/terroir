"use client";

export default function ReconciliationQueueError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="rounded-md border border-primary/30 bg-blush-wash p-md text-[13px] text-primary">
      <p>Reconciliation queue could not be loaded.</p>
      <button type="button" onClick={reset} className="mt-sm h-11 rounded-pill border border-primary/30 bg-white px-md font-medium hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25">Try again</button>
    </section>
  );
}
