export type PublicBinCodeRow = {
  wine_id: string;
  bins: { code: string } | Array<{ code: string }> | null;
};

export function buildBinCodesByWine(
  rows: PublicBinCodeRow[],
): Record<string, string[]> {
  const codesByWine = new Map<string, Set<string>>();

  for (const row of rows) {
    const bins = Array.isArray(row.bins)
      ? row.bins
      : row.bins
        ? [row.bins]
        : [];
    for (const bin of bins) {
      const codes = codesByWine.get(row.wine_id) ?? new Set<string>();
      codes.add(bin.code);
      codesByWine.set(row.wine_id, codes);
    }
  }

  return Object.fromEntries(
    [...codesByWine].map(([wineId, codes]) => [
      wineId,
      [...codes].sort((a, b) => a.localeCompare(b)),
    ]),
  );
}
