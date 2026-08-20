"use client";

export default function ReconciliationQueueError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-md text-[13px] text-danger">
      <p>Reconciliation queue could not be loaded.</p>
      <button type="button" onClick={reset} className="mt-sm h-11 rounded-sm border border-danger/30 bg-white px-md font-medium">Try again</button>
    </section>
  );
}
