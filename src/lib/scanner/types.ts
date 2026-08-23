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

/**
 * Identity-sensitive bottle fields eligible for low-confidence flagging
 * (walkthrough §1.2, item 3). Varietal/country are extracted but not
 * flaggable — they aren't identity-critical the way producer/name/vintage/
 * region/format are for matching a photographed bottle to a cellar record.
 */
export type BottleField = "producer" | "name" | "vintage" | "region" | "format";

/** One ranked wine-identification candidate from a bottle-label photo. */
export type BottleCandidate = {
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string;
  region: string;
  country: string | null;
  /** Bottle size as printed/depicted (e.g. "750ml", "Magnum (1.5L)"). Null if not visible. */
  format: string | null;
  /** Model's self-assessed confidence for this candidate, 0-1 — not a measured accuracy. */
  confidence: number;
  /** Identity-sensitive fields the model is uncertain about for this candidate. */
  lowFields: BottleField[];
  notes: string | null;
};

/**
 * Result of a bottle-label scan: 1-3 ranked candidates, best first. The
 * model returns more than one only when the label is genuinely ambiguous —
 * see BOTTLE_SYSTEM_PROMPT.
 */
export type BottleScanResult = {
  candidates: BottleCandidate[];
  parsedAt: string;
};
