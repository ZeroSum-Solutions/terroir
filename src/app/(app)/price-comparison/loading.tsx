import { RouteDataLoading } from "@/components/route-data-state";
import { Skeleton } from "@/components/skeleton";

export default function PriceComparisonLoading() {
  return (
    <RouteDataLoading label="Loading distributor pricing">
      <section className="mt-md">
        <header className="mb-lg">
          <Skeleton className="h-[28px] w-44 mb-xs" />
          <Skeleton className="h-[15px] w-56" />
        </header>

        <div className="mb-lg rounded-card card-surface p-lg">
          <div className="flex flex-wrap items-baseline gap-lg">
            {["w-24", "w-28", "w-20"].map((width) => (
              <div key={width} className="space-y-xs">
                <Skeleton className={`h-[11px] ${width}`} />
                <Skeleton className="h-[20px] w-16" />
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-card card-surface">
          <div className="flex items-center gap-md bg-bridge-surface px-md py-sm">
            <Skeleton className="h-[11px] w-24" />
            <Skeleton className="ml-auto h-[11px] w-14" />
            <Skeleton className="h-[11px] w-14" />
            <Skeleton className="h-[11px] w-14" />
          </div>
          <div className="divide-y divide-hairline">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center justify-between gap-md px-md py-md">
                <div className="space-y-xs">
                  <Skeleton className="h-[14px] w-40" />
                  <Skeleton className="h-[12px] w-28" />
                </div>
                <div className="flex items-center gap-lg">
                  <Skeleton className="h-[14px] w-14" />
                  <Skeleton className="h-[14px] w-14" />
                  <Skeleton className="h-[14px] w-14" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </RouteDataLoading>
  );
}
