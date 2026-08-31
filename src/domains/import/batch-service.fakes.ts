// Query-aware fakes for the `supabase` client confirmImportBatch /
// applyImportBatchChunk are driven with. Extracted verbatim from
// batch-service.test.ts (SD-41), so producer-acknowledgement.confirm.test.ts
// can drive the same real code path through the same fake rather than
// growing a second, subtly-different copy of it.

import { vi } from "vitest";

/** Dispatches supabase.rpc(name, args) calls to per-name handlers — every
 * P3-era test needs this because confirmImportBatch/applyImportBatchChunk
 * now call TWO different RPCs in one invocation (match_lwin_bulk +
 * create_import_batch, or apply_import_batch_chunk + count_import_batch_
 * rows), so a single canned mockResolvedValue would answer the wrong call
 * with the wrong shape. */
export function makeRpc(handlers: Record<string, (args: unknown) => { data: unknown; error: unknown }>) {
  return vi.fn((name: string, args: unknown) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected rpc ${name}`);
    return Promise.resolve(handler(args));
  });
}

export type FakeBatchRow = {
  id: string;
  status: string;
  session_id: string | null;
  chunk_index: number | null;
  content_sha256: string | null;
  restaurant_id: string;
  created_at: string;
};

/** A minimal, QUERY-AWARE fake for `.from("import_batches")` — unlike a
 * fixed-shape mock, this actually applies eq/neq/or/like filters against
 * an in-memory row list, so the same fake can back both
 * findDuplicateBatch's exact-digest lookup and findLiveBatchByUnderlyingFile's
 * cross-format OR lookup (Sol audit finding 2) without the tests needing
 * to hand-tune a call-count-based mock for every new query shape. `rows`
 * is a live reference — a caller can push into it (e.g. from inside a
 * create_import_batch RPC handler) to simulate either a pre-existing
 * batch or a concurrent insert landing mid-request.
 *
 * Sol round-3 audit (2026-08-27) finding 4: two terminal shapes now exist,
 * mirroring real postgrest-js semantics —
 *   - `.maybeSingle()` ERRORS (never silently returns the first row) when
 *     more than one row matches, exactly like real PGRST116.
 *   - awaiting the builder directly (no `.maybeSingle()`), after
 *     `.order()`/`.limit()`, resolves a real LIST — `{data: Row[], error}`
 *     — sorted per every `.order()` call (in registration order, primary
 *     key first) and sliced to `.limit()`. This is the shape
 *     findLiveBatchByUnderlyingFile now reads.
 * `injectError`, when set, makes the LIST path resolve `{data: null,
 * error}` instead — simulating a genuine lookup failure so the fail-closed
 * behavior (finding 4) can be pinned directly.
 *
 * Round-7 audit finding 1: `appliedBatchIds`, when set, backs the
 * `import_batch_rows` table too — reconcileLiveBatchesForFile's own
 * `.select("batch_id").eq(...).in("batch_id", ids).eq("apply_status",
 * "applied")` query resolves one synthetic `{ batch_id }` row per id that
 * is BOTH in the query's own `.in()` list AND in this set. Only reached
 * when a test's `rows` produces more than one live candidate for the same
 * underlying file — every pre-existing single-candidate test never touches
 * this table at all. */
export function fakeImportBatchesTable(
  rows: FakeBatchRow[],
  options: { injectError?: { code: string; message: string }; appliedBatchIds?: string[] } = {},
) {
  return vi.fn((table: string) => {
    if (table === "import_batch_rows") {
      let inIds: string[] = [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: (_col: string, ids: string[]) => {
          inIds = ids;
          return builder;
        },
        then: (resolve: (value: { data: unknown; error: unknown }) => void) => {
          const applied = new Set(options.appliedBatchIds ?? []);
          resolve({ data: inIds.filter((id) => applied.has(id)).map((id) => ({ batch_id: id })), error: null });
        },
      };
      return builder;
    }
    // BLOCK 2 (round-13 fix) — buildImportPreview's display-name lookup
    // used to reach lwin_catalog directly for every confirm whose
    // match_lwin_bulk mock returned a real (non-null) lwin_id; that
    // separate lookup is deleted outright (match_lwin_bulk's own result
    // already carries display_name — see lwin-matching.test.ts/
    // preview-service.test.ts), so `.from("lwin_catalog")` is never called
    // here anymore.
    if (table !== "import_batches") throw new Error(`unexpected table ${table}`);
    let predicate: (row: FakeBatchRow) => boolean = () => true;
    const orderCols: { col: keyof FakeBatchRow; ascending: boolean }[] = [];
    let limitN: number | null = null;
    const builder = {
      select: () => builder,
      eq: (col: keyof FakeBatchRow, val: unknown) => {
        const prev = predicate;
        predicate = (row) => prev(row) && row[col] === val;
        return builder;
      },
      neq: (col: keyof FakeBatchRow, val: unknown) => {
        const prev = predicate;
        predicate = (row) => prev(row) && row[col] !== val;
        return builder;
      },
      or: (expr: string) => {
        const prev = predicate;
        const clauses = expr.split(",").map((clause) => {
          const [col, op, ...valueParts] = clause.split(".");
          return { col: col as keyof FakeBatchRow, op, value: valueParts.join(".") };
        });
        predicate = (row) =>
          prev(row) &&
          clauses.some(({ col, op, value }) => {
            const cell = row[col];
            if (op === "eq") return cell === value;
            if (op === "neq") return cell !== value;
            if (op === "is") return value === "null" ? cell === null : String(cell) === value;
            if (op === "like") {
              const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
              return typeof cell === "string" && new RegExp(`^${escaped}$`).test(cell);
            }
            return false;
          });
        return builder;
      },
      order: (col: keyof FakeBatchRow, opts?: { ascending?: boolean }) => {
        orderCols.push({ col, ascending: opts?.ascending ?? true });
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      maybeSingle: async () => {
        const matches = rows.filter(predicate);
        if (matches.length > 1) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        }
        return { data: matches[0] ?? null, error: null };
      },
      // Thenable — awaiting the builder directly (the list-read path,
      // no terminal .maybeSingle()) resolves this.
      then(resolve: (value: { data: FakeBatchRow[] | null; error: unknown }) => void) {
        if (options.injectError) {
          resolve({ data: null, error: options.injectError });
          return;
        }
        let result = rows.filter(predicate);
        // Apply sorts in REVERSE registration order — Array.prototype.sort
        // is stable, so sorting least-significant-first and most-
        // significant-last produces correct multi-key ordering exactly
        // like PostgREST's own comma-separated `order=` param.
        for (const { col, ascending } of [...orderCols].reverse()) {
          result = [...result].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av === bv) return 0;
            return (av! < bv! ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        if (limitN !== null) result = result.slice(0, limitN);
        resolve({ data: result, error: null });
      },
    };
    return builder;
  });
}
