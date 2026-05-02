import { formatAbsolute, timeAgo } from "@/lib/time";

/**
 * Renders a relative timestamp ("5m ago") inside a semantic <time>
 * element with two affordances the bare string lacks:
 *
 *   - `dateTime={iso}` — machine-readable for screen readers,
 *     scrapers, and "copy as date" browser features.
 *   - `title={absolute}` — native hover tooltip showing the exact
 *     local date/time, so users can resolve "1d ago" → "Apr 30, 2026,
 *     3:42 PM" without leaving the page.
 *
 * Pure presentational; safe in both server and client components.
 * Pass any extra classes via `className`.
 */
export function TimeAgo({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)} className={className}>
      {timeAgo(iso)}
    </time>
  );
}
