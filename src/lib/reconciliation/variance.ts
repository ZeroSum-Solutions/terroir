import { ML_PER_OZ } from "@/lib/units";

export type ReconciliationRelation = "over" | "under" | "exact";

export type ReconciliationVariance = {
  deltaMl: number;
  relation: ReconciliationRelation;
  percentage: number | null;
  symbol: "↑" | "↓" | "=";
  label: "over expected" | "under expected" | "exact";
};

export function getReconciliationVariance(
  actualMl: number,
  expectedMl: number,
): ReconciliationVariance {
  const deltaMl = actualMl - expectedMl;
  const percentage = expectedMl === 0 ? null : (deltaMl / expectedMl) * 100;
  if (deltaMl > 0) {
    return { deltaMl, relation: "over", percentage, symbol: "↑", label: "over expected" };
  }
  if (deltaMl < 0) {
    return { deltaMl, relation: "under", percentage, symbol: "↓", label: "under expected" };
  }
  return { deltaMl, relation: "exact", percentage, symbol: "=", label: "exact" };
}

export function reconciliationTone(
  relation: ReconciliationRelation,
): "positive" | "negative" | "neutral" {
  if (relation === "over") return "positive";
  if (relation === "under") return "negative";
  return "neutral";
}

export function formatSignedVarianceOz(deltaMl: number): string {
  const ounces = Math.abs(deltaMl / ML_PER_OZ).toFixed(1);
  if (deltaMl > 0) return `+${ounces} oz`;
  if (deltaMl < 0) return `−${ounces} oz`;
  return `${ounces} oz`;
}
