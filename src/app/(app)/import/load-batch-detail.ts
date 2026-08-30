// GET /api/import/batches/[id] into BatchStep's own state. Extracted
// verbatim from import-client.tsx, where it was module-private and shared
// by ImportClient (confirm, and opening a batch from Recent imports) and
// BatchStep's own refresh.

import type { BatchDetail } from "@/domains/import/batch-api-types";

export async function loadBatchDetail(id: string, setBatch: (b: BatchDetail) => void) {
  const response = await fetch(`/api/import/batches/${id}`, { cache: "no-store" });
  if (!response.ok) return;
  setBatch(await response.json());
}
