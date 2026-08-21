import { RouteDataLoading } from "@/components/route-data-state";
import { Skeleton } from "@/components/skeleton";

export default function ReconciliationHistoryLoading() {
  return (
    <RouteDataLoading label="Loading reconciliation history">
      <section className="mt-md">
        <header className="mb-lg flex items-center gap-sm">
          <Skeleton className="h-11 w-11 rounded-sm" />
          <div className="space-y-xs">
            <Skeleton className="h-[28px] w-52" />
            <Skeleton className="h-[12px] w-40" />
          </div>
        </header>
        <Skeleton className="mb-xl h-[184px] w-full rounded-md" />
        <div className="mb-lg grid grid-cols-1 gap-sm sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[76px] w-full rounded-md" />
          ))}
        </div>
        <div className="space-y-md">
          <Skeleton className="h-[20px] w-48" />
          <Skeleton className="h-[112px] w-full rounded-md" />
        </div>
      </section>
    </RouteDataLoading>
  );
}
