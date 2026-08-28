import { describe, expect, it, vi } from "vitest";
import { buildImportPreview } from "./preview-service";
import { LWIN_MATCH_MAX_QUERIES, MAX_ROWS } from "./constants";

function csv(rows: string) {
  return Buffer.from(`producer,name,vintage,quantity,unit_cost\n${rows}`);
}

function makeSupabase(
  matchRows: Array<{ idx: number; lwin_id: string | null; score: number | null }> = [],
  catalogRows: Array<{ lwin_id: string; display_name: string }> = [],
) {
  const from = vi.fn();
  const insert = vi.fn();
  const update = vi.fn();
  const rpc = vi.fn().mockResolvedValue({ data: matchRows, error: null });
  // Sol audit round 3, finding 1: every page request this test's own
  // catalog lookup issues — asserted by the pagination test below to
  // prove the lookup pages to exhaustion instead of a single unpaged
  // read (which PostgREST would silently cap at db.max_rows, 1000).
  const catalogRanges: Array<[number, number]> = [];
  return {
    from: (table: string, ...args: unknown[]) => {
      from(table, ...args);
      // Item 2: the display-name lookup's own table — a plain
      // select().in().order().range() read, distinct from the
      // insert/update-shaped stub every other table gets (this preview
      // endpoint never writes). Sol audit round 3, finding 1: sorted by
      // lwin_id (the real query's own tiebreaker) and sliced by [from,
      // to] — mirrors PostgREST's own page-based pagination, so a
      // catalogRows list beyond one page genuinely proves the fetchAll
      // loop, rather than just returning everything from a single call
      // regardless of range.
      if (table === "lwin_catalog") {
        const sorted = [...catalogRows].sort((a, b) => a.lwin_id.localeCompare(b.lwin_id));
        return {
          select: () => ({
            in: () => ({
              order: () => ({
                range: (from2: number, to2: number) => {
                  catalogRanges.push([from2, to2]);
                  return Promise.resolve({ data: sorted.slice(from2, to2 + 1), error: null });
                },
              }),
            }),
          }),
        };
      }
      return { insert, update, select: () => ({ insert, update }) };
    },
    rpc,
    _from: from,
    _insert: insert,
    _update: update,
    _catalogRanges: catalogRanges,
  } as unknown as Parameters<typeof buildImportPreview>[0] & {
    _from: typeof from;
    _insert: typeof insert;
    _update: typeof update;
    _catalogRanges: typeof catalogRanges;
  };
}

describe("buildImportPreview", () => {
  it("performs zero database writes — only the read-only match RPC and a read-only display-name lookup", async () => {
    const supabase = makeSupabase([{ idx: 0, lwin_id: "LWIN001", score: 0.9 }]);
    await buildImportPreview(supabase, csv("Domaine A,Cuvee 1,2020,6,24.50\n"));

    // Item 2: buildImportPreview now also reads lwin_catalog (a
    // display-name lookup, for the one row that actually matched) — a
    // second read-only call, never a write. Both writer spies below are
    // this test's real guarantee.
    expect(supabase._from).toHaveBeenCalledWith("lwin_catalog");
    expect(supabase._insert).not.toHaveBeenCalled();
    expect(supabase._update).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "match_lwin_bulk",
      expect.objectContaining({ p_queries: expect.any(Array) }),
    );
  });

  it("performs zero table reads when nothing matched — the display-name lookup is skipped entirely", async () => {
    const supabase = makeSupabase([{ idx: 0, lwin_id: null, score: null }]);
    await buildImportPreview(supabase, csv("Domaine A,Cuvee 1,2020,6,24.50\n"));

    expect(supabase._from).not.toHaveBeenCalled();
    expect(supabase._insert).not.toHaveBeenCalled();
    expect(supabase._update).not.toHaveBeenCalled();
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
  it("queries LWIN with full-name and leading-token variants for producer-less rows", async () => {
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
            idx: 0,
            producer: "A.F. Gros Richebourg Grand Cru",
            name: "A.F. Gros Richebourg Grand Cru",
          }),
          expect.objectContaining({
            idx: 1,
            producer: "A.F. Gros",
            name: "A.F. Gros Richebourg Grand Cru",
          }),
          expect.objectContaining({
            idx: 2,
            producer: "A.F. Gros Richebourg",
            name: "A.F. Gros Richebourg Grand Cru",
          }),
        ],
      }),
    );
  });

  it("keeps the best-scoring variant match per producer-less row", async () => {
    // Variant flat idx 1 (producer = first 2 tokens) scores higher than
    // idx 0 (full name in the producer leg) — the row must surface the
    // idx-1 match, proving best-of-variants selection per row.
    const supabase = makeSupabase([
      { idx: 0, lwin_id: "LWIN-WEAK", score: 0.45 },
      { idx: 1, lwin_id: "LWIN-STRONG", score: 0.85 },
    ]);
    const result = await buildImportPreview(
      supabase,
      Buffer.from("wine name,quantity,cost price\nA.F. Gros Richebourg Grand Cru,3,$678.00\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      rowState: "valid",
      lwinId: "LWIN-STRONG",
    });
  });

  it("keeps variant→row alignment when an invalid row is interleaved between producer-less rows", async () => {
    // Row 1 (valid, 3 tokens → flat variants 0,1), row 2 (INVALID: empty
    // name, contributes no variants), row 3 (valid, 6 tokens → flat
    // variants 2,3,4). A match on flat idx 3 must land on row 3 — a
    // shift-by-one bug would drop it or misattribute it.
    const supabase = makeSupabase([{ idx: 3, lwin_id: "LWIN-ROW3", score: 0.8 }]);
    const result = await buildImportPreview(
      supabase,
      Buffer.from(
        "wine name,quantity,cost price\n" +
          "Vietti Barolo Lazzarito,3,$10.00\n" +
          ",1,$5.00\n" +
          "Poggio di Sotto Brunello di Montalcino,2,$20.00\n",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({ rowState: "valid", lwinStatus: "unmatched" });
    expect(result.rows[1]).toMatchObject({ rowState: "error" });
    expect(result.rows[2]).toMatchObject({
      rowState: "valid",
      lwinStatus: "matched",
      lwinId: "LWIN-ROW3",
    });
  });

  it("breaks exact score ties deterministically toward the lowest variant index", async () => {
    const supabase = makeSupabase([
      { idx: 1, lwin_id: "LWIN-V1", score: 0.8 },
      { idx: 0, lwin_id: "LWIN-V0", score: 0.8 },
    ]);
    const result = await buildImportPreview(
      supabase,
      Buffer.from("wine name,quantity,cost price\nA.F. Gros Richebourg Grand Cru,3,$678.00\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({ lwinId: "LWIN-V0" });
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

  describe("lwinDisplayName — item 2 per-row match visibility", () => {
    it("surfaces the catalog display_name for a matched row", async () => {
      const supabase = makeSupabase(
        [{ idx: 0, lwin_id: "LWIN001", score: 0.95 }],
        [{ lwin_id: "LWIN001", display_name: "Domaine A Cuvee One 2020" }],
      );
      const result = await buildImportPreview(supabase, csv("Domaine A,Cuvee 1,2020,6,24.50\n"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0]).toMatchObject({ lwinId: "LWIN001", lwinDisplayName: "Domaine A Cuvee One 2020" });
    });

    it("degrades to null when the matched lwin_id has no catalog row (never fails the preview)", async () => {
      const supabase = makeSupabase([{ idx: 0, lwin_id: "LWIN001", score: 0.95 }], []);
      const result = await buildImportPreview(supabase, csv("Domaine A,Cuvee 1,2020,6,24.50\n"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0]).toMatchObject({ lwinId: "LWIN001", lwinDisplayName: null });
    });

    it("is null for an unmatched row", async () => {
      const supabase = makeSupabase([{ idx: 0, lwin_id: null, score: null }]);
      const result = await buildImportPreview(supabase, csv("Domaine A,Cuvee 1,2020,6,24.50\n"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rows[0]).toMatchObject({ lwinStatus: "unmatched", lwinDisplayName: null });
    });

    // Sol audit round 3, finding 1: MAX_ROWS allows 5,000 matched rows,
    // but PostgREST caps a single response at db.max_rows (1,000 —
    // supabase/config.toml). The catalog display-name lookup used to be
    // one unpaged .in() query, so beyond 1,000 distinct matched lwin_ids,
    // every later row's lwinDisplayName silently degraded to "Catalog
    // entry (name unavailable)" — defeating the per-row visibility
    // feature at exactly the scale it's supposed to hold up at. This
    // proves the lookup now pages to exhaustion: 1,200 distinct matched
    // ids, every one of them still resolving its real display_name, and
    // the mock's own range calls showing more than one page was issued.
    it("resolves every matched row's display name past the 1,000-row PostgREST page cap", async () => {
      const rowCount = 1200;
      const csvBody = Array.from({ length: rowCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`).join("\n");
      const matchRows = Array.from({ length: rowCount }, (_, i) => ({
        idx: i,
        lwin_id: `LWIN${String(i).padStart(5, "0")}`,
        score: 0.95,
      }));
      const catalogRows = Array.from({ length: rowCount }, (_, i) => ({
        lwin_id: `LWIN${String(i).padStart(5, "0")}`,
        display_name: `Domaine ${i} Wine ${i} 2020`,
      }));
      const supabase = makeSupabase(matchRows, catalogRows);

      const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.rows).toHaveLength(rowCount);
      for (let i = 0; i < rowCount; i++) {
        expect(result.rows[i]).toMatchObject({
          lwinId: `LWIN${String(i).padStart(5, "0")}`,
          lwinDisplayName: `Domaine ${i} Wine ${i} 2020`,
        });
      }
      // More than one page was genuinely requested — proves this isn't
      // just a single unpaged call happening to return everything.
      expect(supabase._catalogRanges.length).toBeGreaterThan(1);
    });

    // WARN (round 5 fix) — fetchAll's own "degrades rather than throws on a
    // page error" contract (preview-service.ts), specifically for a page
    // AFTER the first: proves the rows already read from earlier pages
    // survive a later page's failure, rather than the whole lookup
    // discarding everything it already had. This is what makes the
    // documented offset-pagination residual (fetchAll's own comment) safe
    // in practice — a skipped/failed page degrades exactly the rows on
    // that page to lwinDisplayName: null, never the ones already read.
    it("keeps the display names already read from earlier pages when a LATER page errors, rather than losing them all", async () => {
      const rowCount = 1200; // two pages: [0,999] then [1000,1199]
      const csvBody = Array.from({ length: rowCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`).join("\n");
      const matchRows = Array.from({ length: rowCount }, (_, i) => ({
        idx: i,
        lwin_id: `LWIN${String(i).padStart(5, "0")}`,
        score: 0.95,
      }));
      const catalogRows = Array.from({ length: rowCount }, (_, i) => ({
        lwin_id: `LWIN${String(i).padStart(5, "0")}`,
        display_name: `Domaine ${i} Wine ${i} 2020`,
      }));
      const sorted = [...catalogRows].sort((a, b) => a.lwin_id.localeCompare(b.lwin_id));
      const rpc = vi.fn().mockResolvedValue({ data: matchRows, error: null });
      const supabase = {
        from: (table: string) => {
          if (table === "lwin_catalog") {
            return {
              select: () => ({
                in: () => ({
                  order: () => ({
                    range: (from2: number, to2: number) => {
                      // The first page (offset 0) succeeds; every later
                      // page fails — simulating a transient failure that
                      // hits partway through a multi-page read.
                      if (from2 > 0) return Promise.resolve({ data: null, error: { message: "connection reset" } });
                      return Promise.resolve({ data: sorted.slice(from2, to2 + 1), error: null });
                    },
                  }),
                }),
              }),
            };
          }
          return { insert: vi.fn(), update: vi.fn() };
        },
        rpc,
      } as unknown as Parameters<typeof buildImportPreview>[0];

      const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // First page's 1,000 rows still resolved their real display names.
      expect(result.rows[0].lwinDisplayName).toBe("Domaine 0 Wine 0 2020");
      expect(result.rows[999].lwinDisplayName).toBe("Domaine 999 Wine 999 2020");
      // The second (failed) page's rows degrade to null — never a wrong
      // name, and never fails the whole preview.
      expect(result.rows[1000].lwinDisplayName).toBeNull();
      expect(result.rows[1199].lwinDisplayName).toBeNull();
      // Every row's own lwinId/lwinScore (the values actually written) are
      // completely unaffected by the display-name lookup's own failure.
      expect(result.rows[1199].lwinId).toBe("LWIN01199");
      expect(result.rows[1199].lwinScore).toBe(0.95);
    });
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

// BLOCK 2 (round 7 fix) — LWIN_MATCH_MAX_QUERIES: a producer-less row fans
// out to up to 3 LWIN query variants (buildLwinQueryVariants), vs 1 for a
// row with a real producer, so the TOTAL generated query count for one
// preview/confirm unit is `validRows + 2 * producerLessRows` in the worst
// case — never just the producer-less subset alone (see that constant's
// own comment, constants.ts, for the full derivation). Checked BEFORE any
// match_lwin_bulk RPC call. A 4+-token producer-less name always generates
// exactly 3 variants (buildLwinQueryVariants); every producer-less row
// below uses one so its query contribution is exact and deterministic.
//
// NIT 7 (round-29 audit) — CORRECTED: not every test in this block is a
// red-before/green-after proof of the round-7 fix. The "MIXED file" test
// right below, and the exact/one-over boundary tests further down,
// genuinely were red against the pre-round-7 cap (PRODUCER_LESS_MAX_ROWS,
// which counted only producer-less rows) — that is what the round-7 audit
// actually reported. The "producer-bearing row now genuinely counts"
// test and the "does NOT count an invalid row" test below assert
// properties that already held against the PARENT code before round 7's
// fix (an all-producer-bearing file trivially passes any reasonable cap
// either way; an all-invalid-row file was never counted as producer-less
// rows worth rejecting under the old cap either) — they were never red,
// and were never claimed to prove the round-7 fix specifically. They are
// kept as general regression coverage for those two properties, not as
// evidence of what round 7 changed.
//
// Round-10 fix — all boundary numbers below moved from the old cap (4,800)
// to the current one (10,000, constants.ts). Two tests were added: a plain
// MAX_ROWS all-producer-bearing file now passes (the exact contradiction
// this round reconciles), and the producer-less worst case at MAX_ROWS
// (15,000 queries) still correctly fails — the budget still enforces a
// real ceiling, it just no longer rejects the product's own documented
// row-limit capability to do so.
describe("buildImportPreview — LWIN_MATCH_MAX_QUERIES (BLOCK 2, round 7 fix)", () => {
  it("rejects a MIXED file whose TOTAL generated query count exceeds the budget, even though producer-less rows alone are within the old (producer-less-only) cap — the round-7 audit's own reported hole", async () => {
    // Round-11 fix (WARN 2): computed from LWIN_MATCH_MAX_QUERIES/MAX_ROWS
    // rather than hardcoded, so this stays pinned to whatever the budget
    // actually is. producerLessRowsCount is chosen so the file's total
    // query count (producerRowsCount x 1 + producerLessRowsCount x 3)
    // lands a comfortable 10%-of-budget margin OVER LWIN_MATCH_MAX_QUERIES
    // — at exactly MAX_ROWS total rows, the shape of an ordinary max-size
    // mixed file, not a pathological one.
    const excess = Math.ceil(LWIN_MATCH_MAX_QUERIES * 0.1);
    const producerLessRowsCount = Math.ceil((LWIN_MATCH_MAX_QUERIES + excess - MAX_ROWS) / 2);
    const producerRowsCount = MAX_ROWS - producerLessRowsCount;
    const totalQueries = producerRowsCount * 1 + producerLessRowsCount * 3;
    expect(totalQueries).toBeGreaterThan(LWIN_MATCH_MAX_QUERIES);

    const producerRows = Array.from({ length: producerRowsCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`);
    const producerLessRows = Array.from(
      { length: producerLessRowsCount },
      (_, i) => `,Wine Four Token Name ${i},2020,1,10.00`,
    );
    const csvBody = [...producerRows, ...producerLessRows].join("\n");
    const supabase = makeSupabase([]);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too_many_lwin_match_queries");
    expect(result.error.message).toContain(String(totalQueries));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("accepts a file whose TOTAL generated query count is EXACTLY LWIN_MATCH_MAX_QUERIES — the bound is inclusive", async () => {
    // Round-11 fix (WARN 2): computed from the constants — producer-less
    // rows (3 variants each) plus producer-bearing rows (1 each), summing
    // to exactly LWIN_MATCH_MAX_QUERIES queries over exactly MAX_ROWS total
    // rows. producerRowsCount + producerLessRowsCount = MAX_ROWS and
    // producerRowsCount + 3 x producerLessRowsCount = LWIN_MATCH_MAX_QUERIES
    // solve to producerLessRowsCount = (LWIN_MATCH_MAX_QUERIES - MAX_ROWS) / 2.
    const producerLessRowsCount = (LWIN_MATCH_MAX_QUERIES - MAX_ROWS) / 2;
    expect(Number.isInteger(producerLessRowsCount)).toBe(true);
    const producerRowsCount = MAX_ROWS - producerLessRowsCount;
    expect(producerRowsCount + producerLessRowsCount * 3).toBe(LWIN_MATCH_MAX_QUERIES);

    const producerLessRows = Array.from(
      { length: producerLessRowsCount },
      (_, i) => `,Wine Four Token Name ${i},2020,1,10.00`,
    );
    const producerRows = Array.from({ length: producerRowsCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`);
    const csvBody = [...producerLessRows, ...producerRows].join("\n");
    const supabase = makeSupabase([]);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalled();
  });

  it("rejects a file whose TOTAL generated query count is one over LWIN_MATCH_MAX_QUERIES", async () => {
    // Round-11 fix (WARN 2): one query over the budget, one row under
    // MAX_ROWS — solved the same way as the "exactly at the bound" fixture
    // above, but for (LWIN_MATCH_MAX_QUERIES + 1) queries over (MAX_ROWS - 1)
    // total rows, so this is purely a query-budget rejection, not a
    // row-count one. producerLessRowsCount + producerRowsCount = MAX_ROWS - 1
    // and producerLessRowsCount x 3 + producerRowsCount = LWIN_MATCH_MAX_QUERIES + 1
    // solve to producerLessRowsCount = (LWIN_MATCH_MAX_QUERIES - MAX_ROWS + 2) / 2.
    const producerLessRowsCount = (LWIN_MATCH_MAX_QUERIES - MAX_ROWS + 2) / 2;
    expect(Number.isInteger(producerLessRowsCount)).toBe(true);
    const producerRowsCount = MAX_ROWS - 1 - producerLessRowsCount;
    const totalQueries = producerRowsCount + producerLessRowsCount * 3;
    expect(totalQueries).toBe(LWIN_MATCH_MAX_QUERIES + 1);

    const producerLessRows = Array.from(
      { length: producerLessRowsCount },
      (_, i) => `,Wine Four Token Name ${i},2020,1,10.00`,
    );
    const producerRows = Array.from({ length: producerRowsCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`);
    const csvBody = [...producerLessRows, ...producerRows].join("\n");
    const supabase = makeSupabase([]);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too_many_lwin_match_queries");
    expect(result.error.message).toContain(String(totalQueries));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("a producer-bearing row now genuinely counts toward the budget (1 query each) — 2,000 of them stays well within LWIN_MATCH_MAX_QUERIES (10,000)", async () => {
    // This test only proves the narrower, still-true fact: a
    // producer-bearing row counts 1 query each, and 2,000 of them (well
    // under 10,000) passes. See the dedicated "plain MAX_ROWS
    // all-producer-bearing file" test below for the full-size case this
    // round's fix exists to unblock.
    const rowCount = 2000; // every row HAS a producer -> 1 query each -> 2000 total, well under budget
    const csvBody = Array.from({ length: rowCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`).join("\n");
    const matchRows = Array.from({ length: rowCount }, (_, i) => ({ idx: i, lwin_id: null, score: null }));
    const supabase = makeSupabase(matchRows);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(true);
  });

  it("a plain MAX_ROWS all-producer-bearing file passes the budget — round-10 fix", async () => {
    // The exact contradiction round-10 reconciles: a plain MAX_ROWS-row
    // file where every row carries a producer generates exactly MAX_ROWS
    // queries (1 each) — the single most common large-import shape. Under
    // the pre-round-10 cap (4,800) this was rejected before any LWIN RPC
    // call was made. Round-11 fix (WARN 2): the check below pins the
    // headroom this round-10 fix actually promises (LWIN_MATCH_MAX_QUERIES
    // covering at least 2x MAX_ROWS), rather than assuming it from a
    // hardcoded 5,000/10,000 pair.
    expect(LWIN_MATCH_MAX_QUERIES).toBeGreaterThanOrEqual(2 * MAX_ROWS);
    const rowCount = MAX_ROWS; // every row HAS a producer -> exactly MAX_ROWS queries
    const csvBody = Array.from({ length: rowCount }, (_, i) => `Domaine ${i},Wine ${i},2020,1,10.00`).join("\n");
    const matchRows = Array.from({ length: rowCount }, (_, i) => ({ idx: i, lwin_id: null, score: null }));
    const supabase = makeSupabase(matchRows);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalled();
  });

  it("still rejects the producer-less worst case at MAX_ROWS — the budget still does its job", async () => {
    // MAX_ROWS producer-less rows at the worst-case 3 variants each = 3 x
    // MAX_ROWS queries. Round-11 fix (WARN 2): asserted to genuinely exceed
    // the budget (rather than assuming it from hardcoded numbers) before
    // relying on that fact — raising the cap to fit the documented MAX_ROWS
    // capability must not make it so permissive that a genuinely
    // unbounded-wait shape slips through.
    const rowCount = MAX_ROWS; // every row producer-less -> up to 3 queries each
    const totalQueries = rowCount * 3;
    expect(totalQueries).toBeGreaterThan(LWIN_MATCH_MAX_QUERIES);
    const csvBody = Array.from(
      { length: rowCount },
      (_, i) => `,Wine Four Token Name ${i},2020,1,10.00`,
    ).join("\n");
    const supabase = makeSupabase([]);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too_many_lwin_match_queries");
    expect(result.error.message).toContain(String(totalQueries));
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("does NOT count an invalid (error) row toward the budget — an unmatchable row never reaches LWIN matching at all", async () => {
    const rowCount = 1501;
    // Every row producer-less AND missing quantity (required), so every
    // one is an error row, not a valid one — none of them is eligible for
    // LWIN matching, so none should count against the budget.
    const csvBody = Array.from({ length: rowCount }, (_, i) => `,Wine ${i},2020,,10.00`).join("\n");
    const supabase = makeSupabase([]);

    const result = await buildImportPreview(supabase, csv(`${csvBody}\n`));

    expect(result.ok).toBe(true);
  });

  // WARN 5 (round-29 audit): preview (no rowOverrides) and confirm (with
  // rowOverrides) run this exact same budget check but can legitimately
  // disagree — a row an override fixes from invalid to valid starts
  // contributing queries confirm's own count includes, that preview's own
  // count never could have. This proves BOTH halves of that behavior: the
  // same file passes with no overrides (preview), then fails once an
  // override makes its one currently-invalid row valid (confirm) — and the
  // failure message says so explicitly, rather than looking like an
  // unexplained regression from an already-passed preview.
  it("a row fixed by an override can push a file that passed preview over the budget at confirm — the message says why", async () => {
    // Round-11 fix (WARN 2): computed from LWIN_MATCH_MAX_QUERIES instead of
    // hardcoded. validProducerLessCount is the largest row count whose x3
    // query total still sits strictly under the budget — plus ONE
    // producer-less row missing quantity (invalid, contributes 0 queries
    // as-is at preview).
    const validProducerLessCount = Math.floor((LWIN_MATCH_MAX_QUERIES - 1) / 3);
    const previewQueries = validProducerLessCount * 3;
    expect(previewQueries).toBeLessThan(LWIN_MATCH_MAX_QUERIES);
    const validProducerLessRows = Array.from(
      { length: validProducerLessCount },
      (_, i) => `,Wine Four Token Name ${i},2020,1,10.00`,
    );
    const brokenRow = ",Wine Four Token Fixable,2020,,10.00"; // missing quantity -> invalid, 0 queries
    const csvBody = [...validProducerLessRows, brokenRow].join("\n");
    const supabase = makeSupabase([]);

    // No overrides: the broken row stays invalid and contributes nothing,
    // so the total is exactly previewQueries — under the cap, passes.
    const previewResult = await buildImportPreview(supabase, csv(`${csvBody}\n`));
    expect(previewResult.ok).toBe(true);

    // Same file, with an override fixing the broken row's quantity: it is
    // now valid AND producer-less, contributing 3 more queries. This is
    // what confirmImportBatch's own re-derivation would see with the
    // operator's row fix applied.
    const confirmQueries = previewQueries + 3;
    expect(confirmQueries).toBeGreaterThan(LWIN_MATCH_MAX_QUERIES);
    const confirmResult = await buildImportPreview(supabase, csv(`${csvBody}\n`), {
      [String(validProducerLessRows.length + 1)]: { quantity: "6" },
    });
    expect(confirmResult.ok).toBe(false);
    if (confirmResult.ok) return;
    expect(confirmResult.error.code).toBe("too_many_lwin_match_queries");
    expect(confirmResult.error.message).toContain(String(confirmQueries));
    expect(confirmResult.error.message).toContain("1 row fix applied since preview");
  });
});
