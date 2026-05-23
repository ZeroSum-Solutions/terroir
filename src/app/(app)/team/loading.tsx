import { Skeleton } from "@/components/skeleton";

export default function TeamLoading() {
  return (
    <section>
      <header className="mb-lg">
        <Skeleton className="h-[28px] w-24 mb-xs" />
        <Skeleton className="h-[15px] w-40" />
      </header>
      <div className="rounded-md border border-border bg-white">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center justify-between border-b border-border px-md py-md last:border-b-0">
            <div className="flex items-center gap-md">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="space-y-xs">
                <Skeleton className="h-[14px] w-32" />
                <Skeleton className="h-[12px] w-48" />
              </div>
            </div>
            <Skeleton className="h-[20px] w-16 rounded-full" />
          </div>
        ))}
      </div>
    </section>
  );
}
