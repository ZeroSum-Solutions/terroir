import { Skeleton } from "@/components/skeleton";

export default function AtlasLoading() {
  return (
    <section>
      <div className="-mx-md -mt-lg dawn-gradient px-md pb-lg pt-lg md:-mx-lg md:-mt-xl md:px-lg md:pb-xl md:pt-xl">
        <Skeleton className="h-[11px] w-32 mb-xs" />
        <Skeleton className="h-[36px] w-64" />
      </div>
      <div className="px-md py-md md:px-lg">
        <Skeleton className="aspect-[960/500] w-full rounded-lg" />
      </div>
    </section>
  );
}
