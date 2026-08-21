export function newestValidTimestamp(
  values: Array<string | null | undefined>,
): string | null {
  let newestValue: string | null = null;
  let newestEpoch = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (value == null) continue;

    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch) || epoch <= newestEpoch) continue;

    newestValue = value;
    newestEpoch = epoch;
  }

  return newestValue;
}

export function formatMenuFreshness(iso: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

  return `Updated ${formatted}`;
}
