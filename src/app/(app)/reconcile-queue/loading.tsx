export default function LoadingReconciliationQueue() {
  return (
    <section aria-label="Loading reconciliation queue" className="space-y-sm">
      <div className="h-20 animate-pulse rounded-card bg-bridge-surface" />
      {[1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse border-t border-hairline bg-bridge-surface/60" />)}
    </section>
  );
}
