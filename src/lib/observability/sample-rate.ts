/** Parse a validated telemetry sample rate without ever throwing in telemetry. */
export function resolveSampleRate(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
}
