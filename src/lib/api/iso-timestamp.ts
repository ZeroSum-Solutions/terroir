/**
 * Canonicalize an ISO timestamp to UTC without losing PostgreSQL's
 * microsecond precision. Date#toISOString alone truncates the last three
 * fractional digits and would make an exact open-bottle generation look stale.
 */
export function normalizeIsoUtcTimestamp(value: string): string {
  const timezone = value.match(/(?:Z|[+-]\d{2}:\d{2})$/i);
  if (!timezone) {
    throw new TypeError("Timestamp requires an ISO timezone offset.");
  }

  const fractional = value.match(
    /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/i,
  )?.[1];
  if (fractional && fractional.length > 6) {
    throw new TypeError(
      "Timestamp precision exceeds PostgreSQL microseconds.",
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("Timestamp is not a valid ISO datetime.");
  }

  const microseconds = (fractional ?? "").padEnd(6, "0");
  return `${parsed.toISOString().slice(0, 19)}.${microseconds}Z`;
}
