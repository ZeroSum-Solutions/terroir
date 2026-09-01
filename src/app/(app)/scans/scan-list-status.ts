// The scan-history list's status vocabulary, extracted from page.tsx so
// that page could take on the SCAN-04 / D6 "stated reason" rendering
// without growing past the file-size ratchet.
//
// Nothing here changed in the move except this comment.

export type StatusFilter = "all" | "complete" | "processing" | "review" | "failed";

export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "complete", label: "Complete" },
  { value: "processing", label: "Processing" },
  { value: "review", label: "Review" },
  { value: "failed", label: "Failed" },
];

export function parseStatus(raw: string | undefined): StatusFilter {
  if (raw === "complete" || raw === "processing" || raw === "review" || raw === "failed")
    return raw;
  return "all";
}

export function buildQuery(params: { page?: number; status?: StatusFilter }) {
  const parts: string[] = [];
  if (params.page && params.page > 1) parts.push(`page=${params.page}`);
  if (params.status && params.status !== "all") parts.push(`status=${params.status}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export function statusLabel(status: string) {
  switch (status) {
    case "complete":
      return "Complete";
    case "processing":
      return "Processing";
    case "review":
      return "Review";
    case "failed":
      return "Failed";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function statusBadge(status: string) {
  switch (status) {
    case "complete":
      return "bg-ready-wash text-ready-ink";
    case "processing":
      return "bg-hold-wash text-hold-ink";
    case "review":
      // Same risk styling as the confidence gate's arithmetic-mismatch
      // treatment (src/app/(app)/scan/views/confidence-gate.tsx) — "review"
      // rows are here for the same reason: the numbers didn't add up.
      return "bg-risk-wash text-risk-ink";
    case "failed":
      return "bg-primary text-seal-ink";
    default:
      return "bg-wash text-grey";
  }
}
