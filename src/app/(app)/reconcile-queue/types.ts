import type {
  ReconcileQueueRow,
  ReconcileQueueSummary,
} from "@/lib/reconcile-queue";

export type QueueBin = {
  id: string;
  code: string;
  zone: string | null;
};

export type LatestBatch = {
  id: string;
  action_count: number;
  created_at: string;
};

export type QueueResponse = {
  issues: ReconcileQueueRow[];
  summary: ReconcileQueueSummary;
  latest_batch: LatestBatch | null;
  bins: QueueBin[];
};

export type AcceptAction =
  | {
      action_type: "place_bin";
      subject_table: "inventory_items";
      subject_id: string;
      patch: { bin_id: string };
    }
  | {
      action_type: "match_scan";
      subject_table: "invoice_scans";
      subject_id: string;
      patch: {
        line_index: number;
        wine_id: string;
        expected_line: Record<string, unknown>;
      };
    }
  | {
      action_type: "link_lineage";
      subject_table: "wines";
      subject_id: string;
      patch: { lineage_id: string };
    }
  | {
      action_type: "dismiss";
      subject_table: "inventory_items" | "invoice_scans" | "wines";
      subject_id: string;
      patch: Record<string, never>;
    };
