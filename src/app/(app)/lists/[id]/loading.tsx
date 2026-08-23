import { Skeleton } from "@/components/skeleton";

export default function ListEditorLoading() {
  return (
    <div className="flex gap-lg">
      <div className="hidden w-[220px] shrink-0 md:block">
        <div className="space-y-xs">
          <Skeleton className="h-[14px] w-24" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[36px] w-full rounded-pill" />
          ))}
          <Skeleton className="h-[28px] w-28 rounded-pill mt-sm" />
        </div>
      </div>
      <div className="flex-1">
        <Skeleton className="h-[28px] w-48 mb-md" />
        <div className="rounded-card border border-hairline bg-white">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="grid grid-cols-[28px_1fr_80px_80px_36px] items-center gap-md border-b border-hairline px-lg py-sm last:border-b-0"
            >
              <div />
              <div className="space-y-xs">
                <Skeleton className="h-[17px] w-48" />
                <Skeleton className="h-[12px] w-32" />
              </div>
              <Skeleton className="h-[14px] w-12 justify-self-end" />
              <Skeleton className="h-[14px] w-12 justify-self-end" />
              <div />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
