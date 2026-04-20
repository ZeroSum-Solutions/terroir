/**
 * Validation for post-login `?next=` redirect targets.
 *
 * Fixes INT-012 (code-council audit): /auth/callback previously took the raw
 * `next` query param and redirected to `${origin}${next}`, so
 * `?next=//evil.example.com/x` resolved to a cross-origin phish (the browser
 * interprets `https://our-host//evil.example.com/x` as protocol-relative).
 *
 * The helper accepts a candidate and returns it if and only if it is a
 * same-origin path, otherwise it returns a safe fallback. Callers pass the
 * fallback explicitly so the function has no implicit coupling to any route.
 */

/**
 * Return `candidate` if it is a safe same-origin redirect target, else
 * return `fallback`.
 *
 * Accepts:
 *   - A relative path whose first character is `/` AND second character is
 *     not `/` (e.g. `/scanner`, `/wine-lists/42`). Rejects `//evil.com/x`.
 *
 * Rejects everything else: empty string, null/undefined, protocol-relative
 * paths (`//...`), absolute URLs of any scheme (including `data:` and
 * `javascript:`), and any value containing a backslash (Windows-style path
 * injection).
 */
export function safeNext(
  candidate: string | null | undefined,
  fallback: string,
): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return fallback;
  }
  // Back-slashes can trick some URL parsers into treating the rest as a
  // host — reject outright.
  if (candidate.includes("\\")) return fallback;

  // Must start with a single `/` — rejects `//evil.com/x` (protocol-relative)
  // and any absolute-URL form like `http://`, `https://`, `data:`,
  // `javascript:`, `mailto:`, etc.
  if (candidate[0] !== "/" || candidate[1] === "/") return fallback;

  return candidate;
}
