import { Skeleton } from "@/components/skeleton";

export const runtime = "nodejs";

export default function ScansLoading() {
  return (
    <section>
      <header className="mb-lg">
        <Skeleton className="mb-md h-4 w-28" />
        <div className="flex items-center justify-between gap-md">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-6 w-16 rounded-pill" />
        </div>
        <div className="mt-md flex flex-wrap gap-xs">
          <Skeleton className="h-9 w-16 rounded-pill" />
          <Skeleton className="h-9 w-24 rounded-pill" />
          <Skeleton className="h-9 w-28 rounded-pill" />
          <Skeleton className="h-9 w-20 rounded-pill" />
        </div>
      </header>

      {/* Desktop skeleton */}
      <div className="hidden md:block">
        <div className="overflow-hidden rounded-card card-surface">
          <div className="bg-bridge-surface px-md py-sm">
            <div className="flex gap-lg">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          {Array.from({ length: 8 }).map(function (_, i) {
            return (
              <div
                key={i}
                className={`flex gap-lg px-md py-sm ${
                  i > 0 ? "border-t border-hairline" : ""
                }`}
              >
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-8" />
                <Skeleton className="h-5 w-14 rounded-pill" />
                <Skeleton className="h-4 w-10" />
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile skeleton */}
      <div className="flex flex-col gap-sm md:hidden">
        {Array.from({ length: 5 }).map(function (_, i) {
          return (
            <div
              key={i}
              className="flex items-center gap-md rounded-card card-surface p-md"
            >
              <Skeleton className="h-11 w-11 shrink-0 rounded-pill" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="mt-2 h-3 w-24" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Skeleton className="h-4 w-6" />
                <Skeleton className="h-4 w-14 rounded-pill" />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
