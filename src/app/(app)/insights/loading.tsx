import { Skeleton } from "@/components/skeleton";

export default function InsightsLoading() {
  return (
    <div className="space-y-xl">
      <div>
        <Skeleton className="h-[28px] w-32 mb-xs" />
        <Skeleton className="h-[15px] w-64" />
      </div>
      <div className="grid gap-md sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-md border border-border bg-surface p-md">
            <Skeleton className="h-[12px] w-20 mb-sm" />
            <Skeleton className="h-[24px] w-16 mb-xs" />
            <Skeleton className="h-[12px] w-28" />
          </div>
        ))}
      </div>
      <div className="rounded-md border border-border bg-surface p-lg">
        <Skeleton className="h-[16px] w-36 mb-md" />
        <Skeleton className="h-[120px] w-full" />
      </div>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="rounded-md border border-border bg-surface p-lg">
          <Skeleton className="h-[16px] w-40 mb-md" />
          {Array.from({ length: 5 }, (_, j) => (
            <div key={j} className="flex justify-between py-sm border-b border-border/50">
              <Skeleton className="h-[13px] w-32" />
              <Skeleton className="h-[13px] w-16" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
