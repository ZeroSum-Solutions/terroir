"use client";

// The one summary stat tile PreviewStep and BatchStep both render.
// Extracted verbatim from import-client.tsx, where it was module-private
// and shared by exactly these two callers.

export function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-grey">{label}</dt>
      <dd className="tabular text-[20px] font-medium text-ink">{value}</dd>
    </div>
  );
}
