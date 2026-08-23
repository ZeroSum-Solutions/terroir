"use client";

import { ArrowUpDown } from "lucide-react";
import { useRouter } from "next/navigation";

export function SortControls({ current }: { current: { field: string | null; dir: string | null } }) {
  const router = useRouter();
  const isActive = current.field === "variance";
  const isDesc = current.dir === "desc";

  const cycle = () => {
    if (!isActive) {
      router.push("?sort=variance&ord=desc");
    } else if (isDesc) {
      router.push("?sort=variance&ord=asc");
    } else {
      router.push("?");
    }
  };

  return (
    <button type="button" onClick={cycle} className={`flex items-center gap-xs rounded-pill border border-ink/25 px-sm py-xs text-[11px] font-medium uppercase tracking-wide transition-colors hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 ${isActive ? "border-primary text-primary" : "text-ink-subtle"}`}>
      Variance
      <ArrowUpDown className="h-3 w-3" strokeWidth={isActive ? 2.5 : 1.5} />
      {isActive && (
        <span className="ml-xs text-[10px]">{isDesc ? "high first" : "low first"}</span>
      )}
    </button>
  );
}