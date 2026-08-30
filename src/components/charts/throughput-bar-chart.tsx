// ── Bar chart for scan throughput (#148) ──────────────────────────────
export function ThroughputBarChart({ data }: { data: { weekLabel: string; count: number }[] }) {
  if (data.length === 0) return null;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const barHeightMax = 120;

  return (
    <div className="flex items-end gap-1" style={{ height: barHeightMax + 24 }}>
      {data.map((d, i) => {
        const barH = (d.count / maxCount) * barHeightMax;
        return (
          <div
            key={i}
            className="group relative flex flex-1 flex-col items-center justify-end"
          >
            <div
              className="w-full rounded-t-sm bg-accent/70 transition-colors hover:bg-accent"
              style={{ height: Math.max(barH, 2), minWidth: 4 }}
            >
              <div className="invisible absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface-inverse px-1.5 py-0.5 font-mono text-[11px] text-on-inverse opacity-0 transition-opacity group-hover:visible group-hover:opacity-100">
                {d.count}
              </div>
            </div>
            {data.length <= 8 || i % 4 === 0 || i === data.length - 1 ? (
              <span className="mt-1 text-[9px] text-grey">{d.weekLabel}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
