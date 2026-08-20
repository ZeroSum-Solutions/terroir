export default function LoadingReconciliationQueue() {
  return (
    <section aria-label="Loading reconciliation queue" className="space-y-sm">
      <div className="h-20 animate-pulse rounded-md bg-surface-muted" />
      {[1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse border-t border-border bg-surface-muted/60" />)}
    </section>
  );
}
