import { Skeleton } from "@/components/skeleton";

export default function ListsLoading() {
  return (
    <section>
      <header className="mb-xl">
        <Skeleton className="h-[28px] w-36 mb-xs" />
        <Skeleton className="h-[15px] w-80" />
      </header>
      <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-card border border-hairline bg-canvas p-md">
            <div className="flex items-start justify-between gap-sm">
              <Skeleton className="h-[18px] w-40" />
              <Skeleton className="h-[20px] w-16 rounded-full" />
            </div>
            <div className="mt-xs space-y-xs">
              <Skeleton className="h-[13px] w-full" />
              <Skeleton className="h-[13px] w-3/4" />
            </div>
            <div className="mt-md flex items-center justify-between">
              <Skeleton className="h-[12px] w-16" />
              <Skeleton className="h-[12px] w-28" />
            </div>
            <div className="mt-sm flex items-center gap-xs border-t border-hairline pt-sm">
              <Skeleton className="h-[28px] w-[72px] rounded-pill" />
              <Skeleton className="h-[28px] w-[28px] rounded-pill" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
