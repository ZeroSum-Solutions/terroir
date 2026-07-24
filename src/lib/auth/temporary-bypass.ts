import { createHash, timingSafeEqual } from "node:crypto";

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function parseIsoTimestamp(value: string): number | null {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (
    !daysInMonth ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Validate a short-lived temporary production bypass capability.
 *
 * Only a SHA-256 digest is configured server-side. The caller's raw token is
 * hashed before a fixed-length, timing-safe comparison.
 */
export function isValidTemporaryBypassToken(
  expectedSha256: string | undefined,
  expiresAt: string | undefined,
  providedToken: string | null,
): boolean {
  if (!expectedSha256 || !expiresAt || !providedToken) return false;

  const normalizedExpectedHash = expectedSha256.toLowerCase();
  if (!SHA_256_HEX_PATTERN.test(normalizedExpectedHash)) return false;

  const expiresAtMs = parseIsoTimestamp(expiresAt);
  if (expiresAtMs === null || expiresAtMs <= Date.now()) return false;

  const expectedBytes = Buffer.from(normalizedExpectedHash, "hex");
  const providedBytes = createHash("sha256").update(providedToken).digest();
  return timingSafeEqual(expectedBytes, providedBytes);
}
