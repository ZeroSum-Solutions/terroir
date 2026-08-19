/**
 * POST /api/wines/merge (OPP-1, EV-1.2 / EV-1.3).
 *
 * Same mock harness pattern as wines/[id]/availability/route.test.ts.
 * The route pre-checks the merge guards for a friendly 422, but the
 * enforcement layer is the merge_wines RPC (contract-tested separately).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { POST } = await import("./route");

type WineRow = {
  id: string;
  restaurant_id: string;
  lineage_id: string | null;
  vintage: number | null;
  size_ml: number;
  name: string;
  producer: string;
};

function wine(overrides: Partial<WineRow> = {}): WineRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    restaurant_id: "r-1",
    lineage_id: "lin-1",
    vintage: 2019,
    size_ml: 750,
    name: "Côte-Rôtie",
    producer: "Domaine Jamet",
    ...overrides,
  };
}

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

function makeSupabase(
  rows: WineRow[],
  rpcResult: { data: unknown; error: { message: string } | null } = {
    data: { moved_inventory_items: 1 },
    error: null,
  },
) {
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  const from = vi.fn((table: string) => {
    let ids: string[] = [];
    // Thenable builder: select/eq/in all chain; awaiting resolves the rows
    // whose ids were captured by .in().
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: (_col: string, v: string[]) => {
        ids = v;
        return chain;
      },
      then: (
        resolve: (v: { data: WineRow[]; error: null }) => void,
      ) =>
        resolve({
          data: table === "wines" ? rows.filter((r) => ids.includes(r.id)) : [],
          error: null,
        }),
    };
    return chain;
  });
  return { rpc, from } as const;
}

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/wines/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function authOk(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "r-1",
    userId: "u-1",
    role: "manager",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/wines/merge", () => {
  it("is role-gated to owner/manager", async () => {
    const supabase = makeSupabase([]);
    authOk(supabase);
    await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("400s on identical source and target", async () => {
    const supabase = makeSupabase([]);
    authOk(supabase);
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: SOURCE_ID }));
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("404s when either wine is missing", async () => {
    const supabase = makeSupabase([wine({ id: SOURCE_ID })]);
    authOk(supabase);
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(res.status).toBe(404);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("EV-1.3: 422 cross_vintage_merge when vintages differ — RPC never called", async () => {
    const supabase = makeSupabase([
      wine({ id: SOURCE_ID, vintage: 2016 }),
      wine({ id: TARGET_ID, vintage: 2019 }),
    ]);
    authOk(supabase);
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("cross_vintage_merge");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("422 format_mismatch_merge when bottle sizes differ", async () => {
    const supabase = makeSupabase([
      wine({ id: SOURCE_ID, size_ml: 1500 }),
      wine({ id: TARGET_ID }),
    ]);
    authOk(supabase);
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("format_mismatch_merge");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("422 lineage_mismatch_merge when lineages differ or are unset", async () => {
    for (const [srcLin, tgtLin] of [
      ["lin-1", "lin-2"],
      [null, "lin-1"],
      [null, null],
    ] as const) {
      const supabase = makeSupabase([
        wine({ id: SOURCE_ID, lineage_id: srcLin }),
        wine({ id: TARGET_ID, lineage_id: tgtLin }),
      ]);
      authOk(supabase);
      const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toContain("lineage_mismatch_merge");
      expect(supabase.rpc).not.toHaveBeenCalled();
    }
  });

  it("EV-1.2: calls merge_wines RPC on a valid same-vintage pair and reports moved rows", async () => {
    const supabase = makeSupabase(
      [wine({ id: SOURCE_ID, name: "Cote Rotie" }), wine({ id: TARGET_ID })],
      { data: { moved_inventory_items: 3, moved_pour_events: 2 }, error: null },
    );
    authOk(supabase);
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(res.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith("merge_wines", {
      p_source_wine_id: SOURCE_ID,
      p_target_wine_id: TARGET_ID,
    });
    const body = await res.json();
    expect(body.target_id).toBe(TARGET_ID);
    expect(body.moved.moved_inventory_items).toBe(3);
  });

  it("maps RPC guard exceptions to 422 (defense in depth)", async () => {
    const supabase = makeSupabase(
      [wine({ id: SOURCE_ID }), wine({ id: TARGET_ID })],
      { data: null, error: { message: "cross_vintage_merge: vintages 2016 and 2019 differ" } },
    );
    authOk(supabase);
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(res.status).toBe(422);
  });

  it("propagates auth failures untouched", async () => {
    mockRequireRole.mockResolvedValue(NextResponse.json({ error: "nope" }, { status: 403 }));
    const res = await POST(makeRequest({ source_id: SOURCE_ID, target_id: TARGET_ID }));
    expect(res.status).toBe(403);
  });
});
