import { Skeleton } from "@/components/skeleton";

export default function CellarLoading() {
  return (
    <section>
      <header className="mb-lg flex items-center gap-sm">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-[28px] w-24 mb-xs" />
          <Skeleton className="h-[13px] w-40" />
        </div>
      </header>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-white">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="px-md py-md">
            <div className="flex items-start justify-between gap-md">
              <div className="min-w-0 flex-1 space-y-sm">
                <Skeleton className="h-[11px] w-36" />
                <Skeleton className="h-[16px] w-56" />
                <div className="flex gap-sm">
                  <Skeleton className="h-[20px] w-16 rounded-full" />
                  <Skeleton className="h-[12px] w-20" />
                </div>
              </div>
              <Skeleton className="h-8 w-8 shrink-0 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
