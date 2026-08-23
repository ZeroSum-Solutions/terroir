import { RouteDataLoading } from "@/components/route-data-state";
import { Skeleton } from "@/components/skeleton";

export default function TeamLoading() {
  return (
    <RouteDataLoading label="Loading team">
      <section className="mt-md">
        <header className="mb-lg">
          <Skeleton className="h-[11px] w-32 mb-xs" />
          <Skeleton className="h-[28px] w-24" />
        </header>
        <div className="mb-md flex items-center justify-between gap-sm">
          <Skeleton className="h-[15px] w-28" />
          <Skeleton className="h-11 w-40 rounded-pill" />
        </div>
        <div className="grid gap-sm">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="grid gap-md rounded-card border border-hairline bg-canvas p-md sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="space-y-xs">
                <Skeleton className="h-[14px] w-32" />
                <Skeleton className="h-[13px] w-40" />
                <Skeleton className="h-[13px] w-56" />
                <Skeleton className="h-[11px] w-24" />
              </div>
              <Skeleton className="h-11 w-24 rounded-pill sm:justify-self-end" />
            </div>
          ))}
        </div>
      </section>
    </RouteDataLoading>
  );
}
