import { timingSafeEqual } from "node:crypto";

/**
 * Compare the temporary production bypass capability without leaking where
 * a caller's token differs. Both values must be present and exactly equal.
 */
export function isValidTemporaryBypassToken(
  expected: string | undefined,
  provided: string | null,
): boolean {
  if (!expected || !provided) return false;

  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
