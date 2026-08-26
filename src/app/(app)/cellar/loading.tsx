import { Skeleton } from "@/components/skeleton";

export default function CellarLoading() {
  return (
    <section>
      <div className="-mx-md -mt-lg dawn-gradient px-md pb-lg pt-lg md:-mx-lg md:-mt-xl md:px-lg md:pb-xl md:pt-xl">
        <Skeleton className="h-[11px] w-32 mb-xs" />
        <Skeleton className="h-[36px] w-64" />
        <div className="mt-lg grid grid-cols-2 gap-xs md:grid-cols-4 md:gap-sm">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="glass rounded-lg px-md py-sm">
              <Skeleton className="h-[10px] w-16 mb-xs" />
              <Skeleton className="h-[24px] w-12" />
            </div>
          ))}
        </div>
      </div>
      <div className="-mx-md mb-md flex gap-2xs bg-beige px-md py-sm md:-mx-lg md:px-lg">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[32px] w-20 rounded-pill" />
        ))}
      </div>
      <div className="flex flex-col divide-y divide-hairline rounded-card card-surface">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="px-md py-md">
            <div className="flex items-start justify-between gap-md">
              <div className="min-w-0 flex-1 space-y-sm">
                <Skeleton className="h-[11px] w-36" />
                <Skeleton className="h-[17px] w-56" />
                <div className="flex gap-sm">
                  <Skeleton className="h-[20px] w-16 rounded-pill" />
                  <Skeleton className="h-[12px] w-20" />
                </div>
              </div>
              <Skeleton className="h-8 w-8 shrink-0 rounded-pill" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
