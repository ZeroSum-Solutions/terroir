/**
 * Compact relative-time formatter used by the dashboard "Recent activity"
 * feed and the wine-list landing card timestamps. Two call sites had near-
 * identical inline copies that both rendered "0m ago" for diffs under 60s
 * — a small but jarring UX glitch the moment after an action completes.
 *
 * Buckets: < 60s "Just now", < 60m "{n}m ago", < 24h "{n}h ago",
 * < 7d "{n}d ago", else "{n}w ago". Future-dated input is clamped to
 * "Just now" rather than rendering negative numbers.
 */
export function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "Just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
