import { Skeleton } from "@/components/skeleton";

export default function InsightsLoading() {
  return (
    <div className="space-y-xl">
      <div className="dawn-gradient rounded-card px-lg py-xl md:px-2xl md:py-2xl">
        <Skeleton className="h-[12px] w-24 mb-sm bg-white/40" />
        <Skeleton className="h-[44px] w-64 mb-md bg-white/40" />
        <Skeleton className="h-[16px] w-80 max-w-full bg-white/40" />
        <div className="mt-lg grid grid-cols-2 gap-sm md:grid-cols-4 md:gap-md">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="glass rounded-lg p-md">
              <Skeleton className="h-[12px] w-20 mb-sm" />
              <Skeleton className="h-[24px] w-16 mb-xs" />
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-[54px] w-full rounded-card" />
      <div className="rounded-card border border-hairline bg-white p-lg">
        <Skeleton className="h-[16px] w-36 mb-md" />
        <Skeleton className="h-[120px] w-full" />
      </div>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="rounded-card border border-hairline bg-white p-lg">
          <Skeleton className="h-[16px] w-40 mb-md" />
          {Array.from({ length: 5 }, (_, j) => (
            <div key={j} className="flex justify-between py-sm border-b border-hairline/50">
              <Skeleton className="h-[13px] w-32" />
              <Skeleton className="h-[13px] w-16" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
