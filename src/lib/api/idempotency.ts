/**
 * BND-006 / INT-005 — Request-level idempotency for mutating endpoints.
 *
 * Used by the two inventory-save routes so that a client retrying after a
 * network hiccup gets the same response back instead of double-inserting
 * rows. The client generates a UUIDv4 once per "logical save attempt" and
 * sends it in the `Idempotency-Key` header; the same key is reused across
 * network retries but NOT across a successful save (the scanner clears it
 * after the 2xx lands).
 *
 * Storage model (see migration 0011_scan_idempotency.sql):
 *   table scan_idempotency(
 *     key uuid, restaurant_id uuid,
 *     response_status int, response_body jsonb,
 *     created_at timestamptz
 *   )
 *   primary key (key, restaurant_id)
 *
 * Two-phase write so concurrent retries don't collide:
 *   1. INSERT a sentinel row (status/body null). PK = (key, restaurant).
 *      - No conflict → we own the key; run the handler.
 *      - Conflict    → another call already claimed it; look it up.
 *   2. After the handler returns, UPDATE the row with (status, body).
 *      If the handler throws, DELETE the row so the user can retry
 *      cleanly — we never want a server-side exception to permanently
 *      "lock" a key for 24 hours.
 *
 * Scope: the key is scoped to a (key, restaurant_id) pair so a stolen
 * UUID from another tenant cannot replay a response across the boundary.
 * RLS also enforces this server-side — belt and suspenders.
 *
 * NOTE ON TYPING: the `scan_idempotency` table is now in the generated
 * Database type, so `from("scan_idempotency")` returns a fully typed
 * builder. We still downcast the chain to the simplified
 * `LooseQueryBuilder` shape below because Supabase's real
 * `PostgrestQueryBuilder` is deeply generic and would bloat this file
 * without adding meaningful safety — the call sites are all covered
 * by tests in idempotency.test.ts.
 */

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

/** Default TTL for cached responses. Matches the server-side cleanup window. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Result returned to the route handler. */
export type IdempotencyResult<T> = {
  status: number;
  body: T;
  /** True when the response came from the cache rather than a fresh handler run. */
  replayed: boolean;
};

/**
 * Validate a client-supplied Idempotency-Key header.
 *
 * C26 (db audit 2026-08-23): scan_idempotency.key is a `uuid` column
 * (migration 0011). The previous check accepted any opaque
 * [A-Za-z0-9_-]{8,128} string — a non-UUID key made the claim INSERT fail
 * with 22P02 (invalid input syntax for type uuid), which `withIdempotency`
 * treats as "any other error: log and fall through to handler without
 * caching" (a deliberate availability-over-caching choice for genuinely
 * unexpected errors). For this specific, entirely predictable shape
 * mismatch, that meant every retry with a non-UUID key silently ran the
 * handler again with no error ever surfacing to the client — e.g. two
 * `inventory_items` rows inserted for what the caller believed was one
 * save. Every real caller already sends `crypto.randomUUID()` (see
 * src/app/(app)/scan/scanner.tsx), so requiring UUID shape here matches
 * both the column type and actual client behavior; it accepts no fewer
 * real keys than before.
 */
export function isValidIdempotencyKey(raw: string | null): raw is string {
  if (typeof raw !== "string") return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw);
}

// DEBT-015: replaced `type LooseChain = any` with a precise structural
// type covering exactly the chain methods this module uses. The real
// @supabase/postgrest-js builder types are deeply generic and would
// require propagating Database lookups through every helper; the
// trade-off below is "just-enough" typing — eq() returns the same
// builder so chained eq() calls still compose, maybeSingle() ends the
// chain, and insert/update/delete produce a result promise. No `any`
// escape hatches in the module.

type IdempRow = {
  response_status: number | null;
  response_body: Json | null;
  created_at: string;
};

type SupabaseError = { code?: string; message?: string } | null;

interface ChainWithEq<TResult> {
  eq(column: string, value: string): ChainWithEq<TResult>;
  then<TOut>(
    resolve: (v: { data: TResult | null; error: SupabaseError }) => TOut,
  ): Promise<TOut>;
  maybeSingle(): Promise<{ data: TResult | null; error: SupabaseError }>;
}

type LooseQueryBuilder = {
  insert(
    row: Partial<IdempRow> & { key: string; restaurant_id: string },
  ): Promise<{ error: SupabaseError }>;
  select(cols: string): ChainWithEq<IdempRow>;
  update(
    row: Partial<IdempRow>,
  ): ChainWithEq<never>;
  delete(): ChainWithEq<never>;
};

function idempTable(supabase: SupabaseClient<Database>): LooseQueryBuilder {
  // See NOTE ON TYPING above. Typed `from("scan_idempotency")` now
  // resolves against the generated Database; only the chain shape is
  // simplified via LooseQueryBuilder.
  return supabase.from("scan_idempotency") as unknown as LooseQueryBuilder;
}

/**
 * Run `handler` under idempotency protection.
 *
 * Behaviour by input:
 *   - `key === null`        → handler runs, no caching (caller opted out).
 *   - first time for a key  → handler runs, response is cached, replayed=false.
 *   - retry of a completed  → cached (status,body) returned, replayed=true.
 *   - retry while in-flight → 409 "request in progress".
 *   - retry after TTL       → 409 "key expired; generate a new one".
 *
 * If the handler THROWS, the claim row is deleted and the error propagates.
 * This keeps genuine server errors retryable.
 */
export async function withIdempotency<T>(opts: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  key: string | null;
  /** TTL for a cached response. Defaults to 24h — must match the SQL cleanup. */
  ttlMs?: number;
  handler: () => Promise<{ status: number; body: T }>;
  /** Injected clock for tests. */
  now?: () => number;
}): Promise<IdempotencyResult<T>> {
  const {
    supabase,
    restaurantId,
    key,
    ttlMs = IDEMPOTENCY_TTL_MS,
    handler,
    now = Date.now,
  } = opts;

  if (!key) {
    const fresh = await handler();
    return { ...fresh, replayed: false };
  }

  const tbl = idempTable(supabase);

  // ── 1. Claim ────────────────────────────────────────────────────────
  const { error: insertError } = await tbl.insert({
    key,
    restaurant_id: restaurantId,
    response_status: null,
    response_body: null,
  });

  if (insertError) {
    // 23505 = unique_violation → key already claimed.
    if (insertError.code !== "23505") {
      // Any other error: log and fall through to handler without caching,
      // so the endpoint doesn't become unavailable if idempotency is broken.
      console.error("scan_idempotency claim failed:", insertError);
      Sentry.captureException(insertError, {
        tags: { surface: "idempotency", phase: "claim" },
        extra: { code: (insertError as { code?: string }).code },
      });
      const fresh = await handler();
      return { ...fresh, replayed: false };
    }

    // Look up the existing row.
    const { data: existing } = await tbl
      .select("response_status, response_body, created_at")
      .eq("key", key)
      .eq("restaurant_id", restaurantId)
      .maybeSingle();

    if (!existing) {
      // Race: row was deleted between our failed insert and this select.
      // Re-run the handler without caching — worst case the client retries.
      const fresh = await handler();
      return { ...fresh, replayed: false };
    }

    const row = existing as {
      response_status: number | null;
      response_body: Json | null;
      created_at: string;
    };

    const age = now() - Date.parse(row.created_at);
    if (age > ttlMs) {
      return {
        status: 409,
        body: {
          error: "Idempotency key expired; please generate a new one.",
        } as unknown as T,
        replayed: false,
      };
    }

    if (row.response_status === null) {
      return {
        status: 409,
        body: {
          error: "A request with this Idempotency-Key is already in progress.",
        } as unknown as T,
        replayed: false,
      };
    }

    return {
      status: row.response_status,
      body: row.response_body as T,
      replayed: true,
    };
  }

  // ── 2. We own the key. Run the handler. ────────────────────────────
  let result: { status: number; body: T };
  try {
    result = await handler();
  } catch (err) {
    // Unclaim so the user can retry without hitting a stale "in progress".
    await tbl
      .delete()
      .eq("key", key)
      .eq("restaurant_id", restaurantId);
    throw err;
  }

  // ── 3. Cache the response ──────────────────────────────────────────
  const { error: updateError } = await tbl
    .update({
      response_status: result.status,
      response_body: result.body as unknown as Json,
    })
    .eq("key", key)
    .eq("restaurant_id", restaurantId);

  if (updateError) {
    // Non-fatal: the response is still correct, just won't be replayed.
    console.error("scan_idempotency cache update failed:", updateError);
    Sentry.captureException(updateError, {
      tags: { surface: "idempotency", phase: "cache-update" },
    });
  }

  return { ...result, replayed: false };
}
