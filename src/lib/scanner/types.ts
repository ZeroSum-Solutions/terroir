export type LineItemField =
  | "name"
  | "producer"
  | "vintage"
  | "varietal"
  | "region"
  | "qty"
  | "unitCost"
  | "currency"
  | "format";

export type LineItem = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string;
  region: string;
  qty: number;
  unitCost: number;
  /** Extended total for this line as printed on the invoice, if shown. */
  lineTotal?: number | null;
  currency?: string | null;
  format?: string | null;
  confidence: number;
  lowFields?: LineItemField[];
};

export type ScanSource = {
  distributor: string;
  invoiceNo: string;
  invoiceDate: string;
  parsedAt: string;
};

export type ScanQuality = {
  avgConfidence: number;
  lowConfidenceItems: number;
  totalItems: number;
  manualFallbackTriggered: boolean;
  reason?: "low_confidence" | "too_few_items" | "both" | "arithmetic_mismatch";
};

/**
 * Outcome of deterministic invoice arithmetic validation (G1-12) — see
 * `src/domains/scanning/invoice-arithmetic.ts`. Never establishes financial
 * truth itself; it only flags disagreements between extracted numbers for a
 * human to resolve.
 */
export type ArithmeticIssueType =
  | "line_mismatch"
  | "case_bottle_confusion"
  | "currency_mismatch"
  | "invoice_total_mismatch";

export type ArithmeticIssue = {
  type: ArithmeticIssueType;
  lineIndex?: number;
  message: string;
  expected?: number;
  actual?: number;
  /** Case-pack size (e.g. 12) that would reconcile a case_bottle_confusion issue. */
  multiplier?: number;
};

export type ArithmeticValidation = {
  ok: boolean;
  issues: ArithmeticIssue[];
};

export type Scan = {
  source: ScanSource;
  items: LineItem[];
  edits: Record<string, true>;
  quality?: ScanQuality;
  rawText?: string;
  arithmetic?: ArithmeticValidation;
};

export type RecentScan = {
  id: string;
  parsedAt: string;
  distributor: string;
  items: number;
  total: number;
  accuracy: number;
  hasImage: boolean;
};

export type ScanMode = "invoice" | "bottle";

export type BottleScanResult = {
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string;
  region: string;
  country: string | null;
  confidence: number;
  notes: string | null;
  parsedAt: string;
};
