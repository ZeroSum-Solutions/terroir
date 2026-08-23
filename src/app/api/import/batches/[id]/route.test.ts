import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new Request(`http://localhost/api/import/batches/${BATCH_ID}`) as unknown as NextRequest;
}

function params() {
  return Promise.resolve({ id: BATCH_ID });
}

function makeSupabase(options: { batch?: unknown; rows?: unknown[] } = {}) {
  const eqCallsByTable: Record<string, Array<[string, unknown]>> = {};
  const from = vi.fn((table: string) => {
    eqCallsByTable[table] = [];
    if (table === "import_batches") {
      return {
        select: () => ({
          eq: (col: string, val: unknown) => {
            eqCallsByTable[table].push([col, val]);
            return {
              eq: (col2: string, val2: unknown) => {
                eqCallsByTable[table].push([col2, val2]);
                return { maybeSingle: async () => ({ data: options.batch ?? null, error: null }) };
              },
            };
          },
        }),
      };
    }
    if (table === "import_batch_rows") {
      return {
        select: () => ({
          eq: (col: string, val: unknown) => {
            eqCallsByTable[table].push([col, val]);
            return {
              eq: (col2: string, val2: unknown) => {
                eqCallsByTable[table].push([col2, val2]);
                return { order: async () => ({ data: options.rows ?? [], error: null }) };
              },
            };
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { client: { from }, eqCallsByTable };
}

function allow(supabase: unknown) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("GET /api/import/batches/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when the batch isn't found (including cross-tenant)", async () => {
    const { client } = makeSupabase({ batch: null });
    allow(client);
    const response = await GET(request(), { params: params() });
    expect(response.status).toBe(404);
  });

  it("scopes both the batch and row lookups to id + restaurant_id", async () => {
    const { client, eqCallsByTable } = makeSupabase({
      batch: { id: BATCH_ID, status: "created" },
      rows: [{ id: "r1", row_number: 1 }],
    });
    allow(client);
    const response = await GET(request(), { params: params() });
    expect(response.status).toBe(200);
    expect(eqCallsByTable.import_batches).toEqual([
      ["id", BATCH_ID],
      ["restaurant_id", "restaurant-a"],
    ]);
    expect(eqCallsByTable.import_batch_rows).toEqual([
      ["batch_id", BATCH_ID],
      ["restaurant_id", "restaurant-a"],
    ]);
    const body = await response.json();
    expect(body.batch.id).toBe(BATCH_ID);
    expect(body.rows).toEqual([{ id: "r1", row_number: 1 }]);
  });

  it("denies before querying when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await GET(request(), { params: params() });
    expect(response.status).toBe(401);
  });
});
