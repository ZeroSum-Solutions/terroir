import type { LineItem, RecentScan, ScanSource } from "./types";

export const MOCK_SOURCE: ScanSource = {
  distributor: "Kermit Lynch Merchant",
  invoiceNo: "KL-48219",
  invoiceDate: "Apr 15, 2026",
  parsedAt: "2026-04-15T17:42:00Z",
};

export const MOCK_LINE_ITEMS: LineItem[] = [
  { id: "1",  name: "Domaine Leflaive Puligny-Montrachet", producer: "Domaine Leflaive",       vintage: 2021, varietal: "Chardonnay",        region: "Burgundy",             qty: 6,  unitCost: 189.0,  confidence: 0.96 },
  { id: "2",  name: "Château Margaux",                      producer: "Château Margaux",        vintage: 2018, varietal: "Bordeaux Blend",    region: "Bordeaux",             qty: 3,  unitCost: 1240.0, confidence: 0.98 },
  { id: "3",  name: "Quintarelli Valpolicella Classico Superiore", producer: "Giuseppe Quintarelli", vintage: 2014, varietal: "Corvina Blend", region: "Veneto",              qty: 4,  unitCost: 215.5,  confidence: 0.62, lowFields: ["vintage", "varietal"] },
  { id: "4",  name: "Billecart-Salmon Brut Rosé",           producer: "Billecart-Salmon",       vintage: null, varietal: "Champagne Blend",   region: "Champagne",            qty: 12, unitCost: 78.4,   confidence: 0.94 },
  { id: "5",  name: "Ridge Monte Bello",                    producer: "Ridge Vineyards",        vintage: 2019, varietal: "Cabernet Sauvignon",region: "Santa Cruz Mountains", qty: 6,  unitCost: 225.0,  confidence: 0.92 },
  { id: "6",  name: "Keller Riesling Trocken G-Max",        producer: "Weingut Keller",         vintage: 2022, varietal: "Riesling",          region: "Rheinhessen",          qty: 2,  unitCost: 820.0,  confidence: 0.71, lowFields: ["name"] },
  { id: "7",  name: "Produttori del Barbaresco Asili Riserva", producer: "Produttori del Barbaresco", vintage: 2016, varietal: "Nebbiolo",    region: "Piedmont",             qty: 6,  unitCost: 142.0,  confidence: 0.89 },
  { id: "8",  name: "Clos Rougeard Le Bourg",               producer: "Clos Rougeard",          vintage: 2017, varietal: "Cabernet Franc",    region: "Loire Valley",         qty: 3,  unitCost: 445.0,  confidence: 0.58, lowFields: ["unitCost"] },
  { id: "9",  name: "Sandrone Barolo Le Vigne",             producer: "Luciano Sandrone",       vintage: 2019, varietal: "Nebbiolo",          region: "Piedmont",             qty: 6,  unitCost: 165.0,  confidence: 0.93 },
  { id: "10", name: "Egon Müller Scharzhofberger Kabinett", producer: "Egon Müller",            vintage: 2022, varietal: "Riesling",          region: "Mosel",                qty: 4,  unitCost: 240.0,  confidence: 0.87 },
];

export const MOCK_RECENT_SCANS: RecentScan[] = [
  { id: "r1", parsedAt: "2026-04-15", distributor: "Kermit Lynch",       items: 10, total: 13783.8, accuracy: 94 },
  { id: "r2", parsedAt: "2026-04-12", distributor: "Polaner Selections", items: 7,  total: 8640.2,  accuracy: 96 },
  { id: "r3", parsedAt: "2026-04-08", distributor: "Skurnik Wines",      items: 14, total: 15280.0, accuracy: 89 },
];
