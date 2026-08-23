import { Skeleton } from "@/components/skeleton";

export default function ScanLoading() {
  return (
    <section>
      <div className="mb-lg flex items-center justify-center">
        <Skeleton className="h-11 w-48 rounded-pill" />
      </div>
      <header className="mb-lg">
        <Skeleton className="h-[28px] w-48 mb-xs" />
        <Skeleton className="h-[15px] w-64" />
      </header>
      <div className="rounded-card border-2 border-dashed border-beige-deep bg-bridge-surface p-xl">
        <div className="flex flex-col items-center gap-md">
          <Skeleton className="h-14 w-14 rounded-full" />
          <Skeleton className="h-[20px] w-40" />
          <Skeleton className="h-[13px] w-48" />
        </div>
      </div>
      <div className="mt-md grid grid-cols-2 gap-sm">
        <Skeleton className="h-12 rounded-pill" />
        <Skeleton className="h-12 rounded-pill" />
      </div>
      <div className="mt-2xl">
        <div className="mb-md flex items-center justify-between">
          <Skeleton className="h-[14px] w-24" />
          <Skeleton className="h-[14px] w-14" />
        </div>
        <div className="grid grid-cols-1 gap-sm md:grid-cols-3 md:gap-md">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-lg border border-hairline bg-white p-md">
              <div className="mb-sm flex items-center justify-between">
                <Skeleton className="h-[12px] w-16" />
                <Skeleton className="h-[12px] w-8" />
              </div>
              <Skeleton className="mb-xs h-[14px] w-32" />
              <Skeleton className="h-[13px] w-24" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
