import { describe, expect, it, vi } from "vitest";
import { buildImportPreview } from "./preview-service";

function csv(rows: string) {
  return Buffer.from(`producer,name,vintage,quantity,unit_cost\n${rows}`);
}

function makeSupabase(matchRows: Array<{ idx: number; lwin_id: string | null; score: number | null }> = []) {
  const from = vi.fn();
  const insert = vi.fn();
  const update = vi.fn();
  const rpc = vi.fn().mockResolvedValue({ data: matchRows, error: null });
  return {
    from: (...args: unknown[]) => {
      from(...args);
      return { insert, update, select: () => ({ insert, update }) };
    },
    rpc,
    _from: from,
    _insert: insert,
    _update: update,
  } as unknown as Parameters<typeof buildImportPreview>[0] & {
    _from: typeof from;
    _insert: typeof insert;
    _update: typeof update;
  };
}

describe("buildImportPreview", () => {
  it("performs zero database writes and zero table reads — only a read-only RPC call", async () => {
    const supabase = makeSupabase([{ idx: 0, lwin_id: "LWIN001", score: 0.9 }]);
    await buildImportPreview(supabase, csv("Domaine A,Cuvee 1,2020,6,24.50\n"));

    expect(supabase._from).not.toHaveBeenCalled();
    expect(supabase._insert).not.toHaveBeenCalled();
    expect(supabase._update).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "match_lwin_bulk",
      expect.objectContaining({ p_queries: expect.any(Array) }),
    );
  });

  it("returns a per-row preview with row numbers, LWIN status, and cost status", async () => {
    const supabase = makeSupabase([{ idx: 0, lwin_id: "LWIN001", score: 0.95 }]);
    const result = await buildImportPreview(
      supabase,
      csv("Domaine A,Cuvee 1,2020,6,24.50\nDomaine B,Cuvee 2,2019,3,\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 1,
      rowState: "valid",
      lwinStatus: "matched",
      lwinId: "LWIN001",
      costStatus: "present",
      resolution: "auto",
    });
    expect(result.rows[1]).toMatchObject({
      rowNumber: 2,
      rowState: "valid",
      lwinStatus: "unmatched",
      costStatus: "missing",
      resolution: "pending",
    });
    expect(result.summary).toMatchObject({
      totalRows: 2,
      validRows: 2,
      matchedRows: 1,
      unmatchedRows: 1,
      missingCostRows: 1,
      readyToApplyRows: 1,
      pendingResolutionRows: 1,
    });
  });

  it("marks an invalid row as error and excludes it from LWIN matching", async () => {
    const supabase = makeSupabase([]);
    const result = await buildImportPreview(supabase, csv("Domaine A,,2020,6,10\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({ rowState: "error", resolution: "exclude" });
    expect(result.summary.errorRows).toBe(1);

    // Nothing valid to match — the RPC round trip is skipped entirely.
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns a top-level error for missing required headers", async () => {
    const supabase = makeSupabase([]);
    const result = await buildImportPreview(supabase, Buffer.from("region,country\nBurgundy,France\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing_headers");
    expect(result.error.missingHeaders).toEqual(expect.arrayContaining(["name", "quantity"]));
  });

  // Real-world exports (2026-08-27) often have no producer column — the
  // producer lives inside the wine name. match_lwin (0078) hard-gates on
  // producer-leg trigram similarity, so an empty producer would never
  // match anything; the full name goes into BOTH legs instead as a
  // best-effort candidate query. Apply's 0.6 confidence bar (0108) is
  // unchanged, so a weak candidate still never writes a lwin_id.
  it("queries LWIN with the full name in both legs for producer-less rows", async () => {
    const supabase = makeSupabase([]);
    const result = await buildImportPreview(
      supabase,
      Buffer.from("wine name,quantity,cost price\nA.F. Gros Richebourg Grand Cru,3,$678.00\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({ rowState: "valid", costStatus: "present" });
    expect(supabase.rpc).toHaveBeenCalledWith(
      "match_lwin_bulk",
      expect.objectContaining({
        p_queries: [
          expect.objectContaining({
            producer: "A.F. Gros Richebourg Grand Cru",
            name: "A.F. Gros Richebourg Grand Cru",
          }),
        ],
      }),
    );
  });

  it("returns a top-level error for an unparseable file without touching the database", async () => {
    const supabase = makeSupabase([]);
    const result = await buildImportPreview(supabase, Buffer.from(""));
    expect(result.ok).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("carries rawText on every row, valid or error", async () => {
    const supabase = makeSupabase([{ idx: 0, lwin_id: "LWIN001", score: 0.95 }]);
    const result = await buildImportPreview(
      supabase,
      csv("Domaine A,Cuvee 1,2020,6,24.50\nDomaine B,,2020,0.9,10\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].rawText.quantity).toBe("6");
    // Row 2 fails validation (blank name, fractional quantity) — rawText
    // still preserves the original text `raw` would have nulled out.
    expect(result.rows[1].rowState).toBe("error");
    expect(result.rows[1].raw.quantity).toBeNull();
    expect(result.rows[1].rawText.quantity).toBe("0.9");
  });

  describe("rowOverrides — inline row-fix", () => {
    it("applies an override before validation, flipping an error row to valid", async () => {
      const supabase = makeSupabase([{ idx: 0, lwin_id: null, score: null }]);
      const result = await buildImportPreview(
        supabase,
        csv("Domaine A,Cuvee 1,2020,0.9,24.50\n"),
        { "1": { quantity: "6" } },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0]).toMatchObject({ rowState: "valid" });
      expect(result.rows[0].raw.quantity).toBe("6");
    });

    it("returns a clean top-level error for an out-of-bounds override row index, never silently ignoring it", async () => {
      const supabase = makeSupabase([]);
      const result = await buildImportPreview(
        supabase,
        csv("Domaine A,Cuvee 1,2020,6,24.50\n"),
        { "5": { quantity: "6" } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_row_override");
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("rejects row index 0 as out of bounds (rows are 1-indexed)", async () => {
      const supabase = makeSupabase([]);
      const result = await buildImportPreview(
        supabase,
        csv("Domaine A,Cuvee 1,2020,6,24.50\n"),
        { "0": { quantity: "6" } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_row_override");
    });
  });
});
