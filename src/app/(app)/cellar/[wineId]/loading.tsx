import { Skeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1100px] px-lg pb-3xl">
      <div className="mt-md grid gap-xl py-2xl md:grid-cols-[minmax(0,300px)_minmax(0,1fr)] md:gap-2xl md:py-3xl">
        <Skeleton className="mx-auto h-[280px] w-[168px] rounded-card" />
        <div className="flex flex-col justify-center gap-md">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-12 w-full max-w-[520px]" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
    </div>
  );
}
