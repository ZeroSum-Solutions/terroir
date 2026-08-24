/**
 * Unit tests for `withIdempotency` and `isValidIdempotencyKey` (BND-006).
 *
 * The helper talks to Supabase but we don't need a real database —
 * every code path is a sequence of query-builder calls, so we fake
 * the client with a query-log + scripted error/return values.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDEMPOTENCY_TTL_MS,
  isValidIdempotencyKey,
  withIdempotency,
} from "./idempotency";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/** Minimal in-memory scan_idempotency table for tests. */
type Row = {
  key: string;
  restaurant_id: string;
  response_status: number | null;
  response_body: unknown;
  created_at: string;
};

/** Build a fake Supabase client that speaks just enough of the builder API. */
function makeFakeClient(initialRows: Row[] = []) {
  const rows: Row[] = [...initialRows];
  const events: string[] = [];

  /** A lightweight "select / update / delete" chain. */
  function chain(op: "select" | "update" | "delete", row?: Partial<Row>) {
    const filters: Record<string, string> = {};
    const api = {
      eq(col: string, val: string) {
        filters[col] = val;
        return api;
      },
      async maybeSingle() {
        const found = rows.find(
          (r) => r.key === filters.key && r.restaurant_id === filters.restaurant_id,
        );
        events.push(`select ${filters.key}`);
        return { data: found ?? null, error: null };
      },
      // For update/delete we defer the work until the caller awaits the chain.
      then<A>(resolve: (v: { error: null }) => A) {
        if (op === "update" && row) {
          const found = rows.find(
            (r) =>
              r.key === filters.key && r.restaurant_id === filters.restaurant_id,
          );
          if (found) Object.assign(found, row);
          events.push(`update ${filters.key}`);
        } else if (op === "delete") {
          const idx = rows.findIndex(
            (r) =>
              r.key === filters.key && r.restaurant_id === filters.restaurant_id,
          );
          if (idx >= 0) rows.splice(idx, 1);
          events.push(`delete ${filters.key}`);
        }
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return api;
  }

  const client = {
    from(table: string) {
      if (table !== "scan_idempotency") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        async insert(payload: Omit<Row, "created_at"> & { created_at?: string }) {
          const exists = rows.some(
            (r) =>
              r.key === payload.key &&
              r.restaurant_id === payload.restaurant_id,
          );
          if (exists) {
            events.push(`insert-conflict ${payload.key}`);
            return { error: { code: "23505" } };
          }
          rows.push({
            key: payload.key,
            restaurant_id: payload.restaurant_id,
            response_status: payload.response_status ?? null,
            response_body: payload.response_body ?? null,
            created_at: payload.created_at ?? new Date().toISOString(),
          });
          events.push(`insert ${payload.key}`);
          return { error: null };
        },
        select(_cols: string) {
          return chain("select");
        },
        update(row: Partial<Row>) {
          return chain("update", row);
        },
        delete() {
          return chain("delete");
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient<Database>,
    rows,
    events,
  };
}

const KEY_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const RESTAURANT = "rest-1";

describe("isValidIdempotencyKey", () => {
  it("accepts a well-formed UUID string", () => {
    expect(isValidIdempotencyKey(KEY_A)).toBe(true);
  });
  // C26 (db audit 2026-08-23): this used to assert "abc_DEF-123xyz" (a
  // non-UUID opaque token) was VALID, even though scan_idempotency.key is
  // a `uuid` column — every non-UUID key silently defeated caching (the
  // claim INSERT threw 22P02, caught and treated as "fall through to
  // handler uncached"). Every real caller sends crypto.randomUUID(), so
  // the contract is now UUID-shaped, matching the column type.
  it("rejects an opaque token that isn't UUID-shaped, even though it was previously accepted", () => {
    expect(isValidIdempotencyKey("abc_DEF-123xyz")).toBe(false);
  });
  it("rejects null / undefined / non-strings", () => {
    expect(isValidIdempotencyKey(null)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isValidIdempotencyKey(undefined as any)).toBe(false);
  });
  it("rejects UUID-length strings that aren't UUID-shaped", () => {
    expect(isValidIdempotencyKey("1234567")).toBe(false); // 7 chars
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    // 36 chars, UUID-length, but missing the hyphen grouping.
    expect(isValidIdempotencyKey("aaaaaaaabbbbccccddddeeeeeeeeeeee0000")).toBe(false);
  });
  it("rejects keys with illegal characters", () => {
    expect(isValidIdempotencyKey("hello world!")).toBe(false);
    expect(isValidIdempotencyKey("key/with/slashes")).toBe(false);
  });
  it("accepts uppercase-hex UUIDs (case-insensitive)", () => {
    expect(isValidIdempotencyKey("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(true);
  });
});

describe("withIdempotency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the handler when key is null and does not touch the table", async () => {
    const { client, events } = makeFakeClient();
    const handler = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });

    const result = await withIdempotency({
      supabase: client,
      restaurantId: RESTAURANT,
      key: null,
      handler,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 200, body: { ok: true }, replayed: false });
    expect(events).toEqual([]);
  });

  it("first call claims the key, runs handler, and caches the response", async () => {
    const { client, rows, events } = makeFakeClient();
    const handler = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { scanId: "s1" } });

    const result = await withIdempotency({
      supabase: client,
      restaurantId: RESTAURANT,
      key: KEY_A,
      handler,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 201,
      body: { scanId: "s1" },
      replayed: false,
    });
    expect(events).toEqual([`insert ${KEY_A}`, `update ${KEY_A}`]);
    expect(rows).toHaveLength(1);
    expect(rows[0].response_status).toBe(201);
    expect(rows[0].response_body).toEqual({ scanId: "s1" });
  });

  it("second call with same key replays the cached response without re-running the handler", async () => {
    const now = new Date().toISOString();
    const { client, events } = makeFakeClient([
      {
        key: KEY_A,
        restaurant_id: RESTAURANT,
        response_status: 201,
        response_body: { scanId: "s1" },
        created_at: now,
      },
    ]);
    const handler = vi.fn();

    const result = await withIdempotency({
      supabase: client,
      restaurantId: RESTAURANT,
      key: KEY_A,
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 201,
      body: { scanId: "s1" },
      replayed: true,
    });
    expect(events).toContain(`insert-conflict ${KEY_A}`);
  });

  it("returns 409 when the same key is seen while a prior call is still in-flight", async () => {
    const { client } = makeFakeClient([
      {
        key: KEY_A,
        restaurant_id: RESTAURANT,
        response_status: null, // not yet written → still running
        response_body: null,
        created_at: new Date().toISOString(),
      },
    ]);
    const handler = vi.fn();

    const result = await withIdempotency({
      supabase: client,
      restaurantId: RESTAURANT,
      key: KEY_A,
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe(409);
    expect(result.replayed).toBe(false);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/in progress/i) });
  });

  it("returns 409 when a cached row is older than the TTL", async () => {
    const old = new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000).toISOString();
    const { client } = makeFakeClient([
      {
        key: KEY_A,
        restaurant_id: RESTAURANT,
        response_status: 201,
        response_body: { scanId: "s1" },
        created_at: old,
      },
    ]);
    const handler = vi.fn();

    const result = await withIdempotency({
      supabase: client,
      restaurantId: RESTAURANT,
      key: KEY_A,
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/expired/i) });
  });

  it("deletes the claim row and re-throws if the handler throws", async () => {
    const { client, rows, events } = makeFakeClient();
    const boom = new Error("handler blew up");
    const handler = vi.fn().mockRejectedValue(boom);

    await expect(
      withIdempotency({
        supabase: client,
        restaurantId: RESTAURANT,
        key: KEY_A,
        handler,
      }),
    ).rejects.toBe(boom);

    expect(rows).toHaveLength(0);
    expect(events).toEqual([`insert ${KEY_A}`, `delete ${KEY_A}`]);
  });

  it("scopes (key, restaurant_id) — same key in different tenants does not replay", async () => {
    const { client, events } = makeFakeClient([
      {
        key: KEY_A,
        restaurant_id: "rest-other",
        response_status: 201,
        response_body: { scanId: "from-other-tenant" },
        created_at: new Date().toISOString(),
      },
    ]);
    const handler = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { scanId: "mine" } });

    const result = await withIdempotency({
      supabase: client,
      restaurantId: RESTAURANT, // different tenant
      key: KEY_A,
      handler,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(result.body).toEqual({ scanId: "mine" });
    expect(result.replayed).toBe(false);
    // A fresh insert happened for this tenant (no conflict).
    expect(events).toContain(`insert ${KEY_A}`);
  });
});
