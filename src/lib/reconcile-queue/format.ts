import type { BottleFormatInput } from "./types";

const COMMON_BOTTLE_ML = new Set([
  187, 200, 250, 375, 500, 620, 700, 720, 750, 1_000, 1_500, 3_000,
  4_500, 5_000, 6_000, 9_000, 12_000, 15_000, 18_000, 27_000, 30_000,
]);

function commonMilliliters(value: number): number | null {
  return Number.isInteger(value) && COMMON_BOTTLE_ML.has(value) ? value : null;
}

export function parseBottleFormat(input: BottleFormatInput): number | null {
  if (typeof input === "number") return commonMilliliters(input);
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(ml|cl|l)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const milliliters = unit === "l" ? value * 1_000 : unit === "cl" ? value * 10 : value;
  return commonMilliliters(milliliters);
}
