import { Skeleton } from "@/components/skeleton";

export default function PriceComparisonLoading() {
  return (
    <section>
      <header className="mb-lg">
        <Skeleton className="h-[28px] w-44 mb-xs" />
        <Skeleton className="h-[15px] w-56" />
      </header>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-white">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center justify-between px-md py-md">
            <div className="space-y-xs">
              <Skeleton className="h-[14px] w-40" />
              <Skeleton className="h-[12px] w-28" />
            </div>
            <Skeleton className="h-[14px] w-16" />
          </div>
        ))}
      </div>
    </section>
  );
}
