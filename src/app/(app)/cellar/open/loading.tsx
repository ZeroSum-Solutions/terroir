import { RouteDataLoading } from "@/components/route-data-state";
import { Skeleton } from "@/components/skeleton";

export default function OpenBottlesLoading() {
  return (
    <RouteDataLoading label="Loading open bottles">
      <section className="mt-md">
        <header className="mb-lg flex items-center gap-sm">
          <Skeleton className="h-11 w-11 rounded-pill" />
          <div className="space-y-xs">
            <Skeleton className="h-[28px] w-40" />
            <Skeleton className="h-[12px] w-28" />
          </div>
        </header>
        <div className="divide-y divide-hairline rounded-card card-surface">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-md px-lg py-md">
              <div className="space-y-xs">
                <Skeleton className="h-[17px] w-52" />
                <Skeleton className="h-[12px] w-32" />
              </div>
              <Skeleton className="h-[32px] w-24 rounded-pill" />
            </div>
          ))}
        </div>
      </section>
    </RouteDataLoading>
  );
}
