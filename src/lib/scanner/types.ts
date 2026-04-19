export type LineItemField =
  | "name"
  | "producer"
  | "vintage"
  | "varietal"
  | "region"
  | "qty"
  | "unitCost";

export type LineItem = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string;
  region: string;
  qty: number;
  unitCost: number;
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
  reason?: "low_confidence" | "too_few_items" | "both";
};

export type Scan = {
  source: ScanSource;
  items: LineItem[];
  edits: Record<string, true>;
  quality?: ScanQuality;
  rawText?: string;
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
