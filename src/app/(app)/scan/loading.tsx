import { Skeleton } from "@/components/skeleton";

export default function ScanLoading() {
  return (
    <section>
      <header className="mb-lg">
        <Skeleton className="h-[28px] w-24 mb-xs" />
        <Skeleton className="h-[15px] w-48" />
      </header>
      <div className="rounded-card border border-hairline bg-bridge-surface p-xl">
        <div className="flex flex-col items-center gap-md">
          <Skeleton className="h-16 w-16 rounded-full" />
          <Skeleton className="h-[16px] w-48" />
          <Skeleton className="h-[40px] w-40 rounded-pill" />
        </div>
      </div>
      <div className="mt-xl">
        <Skeleton className="h-[16px] w-32 mb-md" />
        <div className="space-y-sm">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-hairline bg-white px-md py-md">
              <div className="space-y-xs">
                <Skeleton className="h-[14px] w-36" />
                <Skeleton className="h-[12px] w-24" />
              </div>
              <Skeleton className="h-8 w-8 rounded-pill" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
