import { Skeleton } from "@/components/skeleton";

export default function ListEditorLoading() {
  return (
    <div className="flex gap-lg">
      <div className="hidden w-[220px] shrink-0 md:block">
        <div className="space-y-xs">
          <Skeleton className="h-[14px] w-24" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[36px] w-full rounded-sm" />
          ))}
          <Skeleton className="h-[28px] w-28 rounded-sm mt-sm" />
        </div>
      </div>
      <div className="flex-1">
        <Skeleton className="h-[28px] w-48 mb-md" />
        <div className="space-y-2xs">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-md rounded-sm border border-border bg-white px-md py-md">
              <Skeleton className="h-10 w-10 shrink-0 rounded-sm" />
              <div className="flex-1 space-y-xs">
                <Skeleton className="h-[15px] w-48" />
                <Skeleton className="h-[12px] w-32" />
              </div>
              <Skeleton className="h-[16px] w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
