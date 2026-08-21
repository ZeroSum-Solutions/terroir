const PRESET_RANGES = new Set(["7d", "30d", "90d", "ytd", "all"]);

export type NormalizedInsightsRange = {
  range: string;
  from: string | undefined;
  to: string | undefined;
};

export function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && formatLocalDate(date) === value;
}

export function isValidCustomRange(
  from: string,
  to: string,
  localToday = formatLocalDate(new Date()),
): boolean {
  return (
    isCalendarDate(from) &&
    isCalendarDate(to) &&
    isCalendarDate(localToday) &&
    from <= to &&
    to <= localToday
  );
}

export function normalizeInsightsRange(
  range: string | undefined,
  from: string | undefined,
  to: string | undefined,
  localToday = formatLocalDate(new Date()),
): NormalizedInsightsRange {
  if (range === "custom" && from && to && isValidCustomRange(from, to, localToday)) {
    return { range, from, to };
  }
  if (range && PRESET_RANGES.has(range)) {
    return { range, from: undefined, to: undefined };
  }
  return { range: "all", from: undefined, to: undefined };
}

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
        if (isCalendarDate(from) && !Number.isNaN(d.getTime())) return d;
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
  return isCalendarDate(to) && !Number.isNaN(d.getTime()) ? d : null;
}
