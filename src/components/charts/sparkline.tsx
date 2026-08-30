export type SparklinePoint = { value: number; date?: string };

function formatSparkDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function Sparkline({ data }: { data: SparklinePoint[] }) {
  if (data.length < 2) return null;
  const width = 440;
  const height = 100;
  const pad = 6;
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + (1 - (d.value - min) / range) * h;
    return { x, y, value: d.value, date: d.date };
  });

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${path} L ${last.x.toFixed(1)},${height - pad} L ${first.x.toFixed(1)},${height - pad} Z`;

  const ariaLabel =
    `Scan activity over the last ${data.length} scans: ` +
    `${min}–${max} items per scan, most recent ${last.value}.`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      className="block"
    >
      <defs>
        <linearGradient id="spark-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#spark-grad)" />
      <path
        d={path}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((p, i) => {
        const dateLabel = formatSparkDate(p.date);
        const tooltip =
          `${p.value} item${p.value === 1 ? "" : "s"}` +
          (dateLabel ? ` · ${dateLabel}` : "");
        const isLast = i === points.length - 1;
        return (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r={isLast ? 4 : 2.5}
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth={isLast ? 2 : 1}
              opacity={isLast ? 1 : 0.7}
            />
            <circle cx={p.x} cy={p.y} r="10" fill="transparent">
              <title>{tooltip}</title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}
