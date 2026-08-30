// Client-facing shapes of the import-batch read endpoints
// (GET /api/import/batches and GET /api/import/batches/[id]), extracted
// verbatim from import-client.tsx, which re-exports all three unchanged.

export type BatchSummary = {
  id: string;
  filename: string;
  status: "created" | "applying" | "completed" | "reverted";
  total_rows: number;
  created_at: string;
  reverted_at: string | null;
};

export type BatchRow = {
  id: string;
  row_number: number;
  raw: Record<string, string | null>;
  row_state: "valid" | "error";
  validation_errors: { field: string; message: string }[];
  lwin_status: "matched" | "unmatched";
  lwin_id: string | null;
  /** Item 2 (per-row LWIN match visibility): the server (GET /api/import/
   * batches/[id]) already sends this — it was previously dropped here even
   * though every persisted row carries it (import_batch_rows.lwin_score). */
  lwin_score: number | null;
  cost_status: "present" | "missing";
  resolution: "auto" | "pending" | "include" | "exclude";
  manual_unit_cost: number | null;
  apply_status: "not_applied" | "applied" | "reverted";
};

export type BatchDetail = { batch: BatchSummary; rows: BatchRow[] };
