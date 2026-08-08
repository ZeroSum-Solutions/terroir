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

function utcCalendarBoundary(value: string, endOfDay: boolean): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const date = new Date(value + suffix);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

export function isValidCustomDateRange(
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (!from || !to) return false;
  const since = utcCalendarBoundary(from, false);
  const until = utcCalendarBoundary(to, true);
  return since != null && until != null && since.getTime() <= until.getTime();
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
      return from ? utcCalendarBoundary(from, false) : null;
    default:
      return null;
  }
}

export function dateRangeUntil(
  range: string | undefined,
  to: string | undefined,
): Date | null {
  if (range !== "custom" || !to) return null;
  return utcCalendarBoundary(to, true);
}
