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

export type Scan = {
  source: ScanSource;
  items: LineItem[];
  edits: Record<string, true>;
};

export type RecentScan = {
  id: string;
  parsedAt: string;
  distributor: string;
  items: number;
  total: number;
  accuracy: number;
};
