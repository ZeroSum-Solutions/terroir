export function dateRangeLabel(
  range: string | undefined,
  from: string | undefined,
  to: string | undefined,
): string {
  switch (range) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "ytd":
      return "Year to date";
    case "custom":
      if (from && to) return from + " – " + to;
      return "Custom range";
    default:
      return "All time";
  }
}

export function dateRangeSince(
  range: string | undefined,
  from: string | undefined,
): Date | null {
  switch (range) {
    case "7d": {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "30d": {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "90d": {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "ytd": {
      const d = new Date();
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "custom":
      if (from) {
        const d = new Date(from + "T00:00:00");
        if (!Number.isNaN(d.getTime())) return d;
      }
      return null;
    default:
      return null;
  }
}

export function dateRangeUntil(
  range: string | undefined,
  to: string | undefined,
): Date | null {
  if (range !== "custom" || !to) return null;
  const d = new Date(to + "T23:59:59.999");
  return Number.isNaN(d.getTime()) ? null : d;
}
