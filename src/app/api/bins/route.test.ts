import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
const mockRequireRole = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { GET, POST } = await import("./route");

type Result = { data: unknown; error: unknown };
type Operation = [string, ...unknown[]];

function makeSupabase(results: Record<string, Result>) {
  const operations: Record<string, Operation[]> = {};
  const from = vi.fn((table: string) => {
    const ops = (operations[table] ??= []);
    const chain = {
      select: (...args: unknown[]) => (ops.push(["select", ...args]), chain),
      eq: (...args: unknown[]) => (ops.push(["eq", ...args]), chain),
      is: (...args: unknown[]) => (ops.push(["is", ...args]), chain),
      order: (...args: unknown[]) => (ops.push(["order", ...args]), chain),
      in: (...args: unknown[]) => (ops.push(["in", ...args]), chain),
      insert: (...args: unknown[]) => (ops.push(["insert", ...args]), chain),
      single: async () => results[table] ?? { data: null, error: null },
      then: (resolve: (value: Result) => unknown) =>
        Promise.resolve(results[table] ?? { data: null, error: null }).then(
          resolve,
        ),
    };
    return chain;
  });
  return { from, operations };
}

function allowMember(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

function allowManager(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "manager",
  });
}

function postRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/bins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("GET /api/bins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([401, 403])(
    "returns an auth denial before database access (%s)",
    async (status) => {
      const supabase = makeSupabase({});
      mockRequireMembership.mockResolvedValue(
        NextResponse.json({ error: "denied" }, { status }),
      );

      const response = await GET();

      expect(response.status).toBe(status);
      expect(supabase.from).not.toHaveBeenCalled();
    },
  );

  it("returns active tenant bins with distinct-wine and bottle occupancy", async () => {
    const bins = [
      {
        id: "bin-a",
        code: "A-01",
        zone: "Reds",
        capacity: 12,
        priority: 4,
        sort_order: 2,
      },
      {
        id: "bin-b",
        code: "B-01",
        zone: null,
        capacity: null,
        priority: 0,
        sort_order: 3,
      },
    ];
    const supabase = makeSupabase({
      bins: { data: bins, error: null },
      inventory_items: {
        data: [
          { bin_id: "bin-a", wine_id: "wine-1", quantity: 2 },
          { bin_id: "bin-a", wine_id: "wine-1", quantity: 1 },
          { bin_id: "bin-a", wine_id: "wine-2", quantity: 4 },
          { bin_id: "bin-b", wine_id: "wine-3", quantity: 2 },
        ],
        error: null,
      },
    });
    allowMember(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { ...bins[0], wine_count: 2, bottle_count: 7 },
      { ...bins[1], wine_count: 1, bottle_count: 2 },
    ]);
    expect(supabase.operations.bins).toContainEqual([
      "select",
      "id, code, zone, capacity, priority, sort_order",
    ]);
    expect(supabase.operations.bins).toContainEqual([
      "eq",
      "restaurant_id",
      "restaurant-a",
    ]);
    expect(supabase.operations.bins).toContainEqual([
      "is",
      "retired_at",
      null,
    ]);
    expect(supabase.operations.inventory_items).toContainEqual([
      "eq",
      "restaurant_id",
      "restaurant-a",
    ]);
    expect(supabase.operations.inventory_items).toContainEqual([
      "in",
      "bin_id",
      ["bin-a", "bin-b"],
    ]);
  });

  it("returns empty active bins without querying inventory", async () => {
    const supabase = makeSupabase({ bins: { data: [], error: null } });
    allowMember(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("redacts and captures database failures", async () => {
    const error = { code: "XX000", message: "password=secret" };
    const supabase = makeSupabase({ bins: { data: null, error } });
    allowMember(supabase);

    const response = await GET();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).error.code).toBe("internal_error");
    expect(mockCaptureException).toHaveBeenCalledWith(new Error("bins list failed"), {
      tags: { surface: "bins", phase: "list" },
      extra: { restaurantId: "restaurant-a" },
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("secret");
    expect(console.error).toHaveBeenCalledWith("bins list failed");
  });
});

describe("POST /api/bins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([401, 403])(
    "uses the manager role gate and stops before database access (%s)",
    async (status) => {
      const supabase = makeSupabase({});
      mockRequireRole.mockResolvedValue(
        NextResponse.json({ error: "denied" }, { status }),
      );

      const response = await POST(postRequest({ code: "A-01" }));

      expect(response.status).toBe(status);
      expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
      expect(supabase.from).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid JSON", "{not json"],
    ["blank code", { code: "   " }],
    ["oversized code", { code: "x".repeat(51) }],
    ["oversized zone", { code: "A", zone: "x".repeat(101) }],
    ["non-positive capacity", { code: "A", capacity: 0 }],
    ["fractional priority", { code: "A", priority: 1.5 }],
    ["unknown fields", { code: "A", restaurant_id: "restaurant-b" }],
  ])("returns 400 for %s before inserting", async (_name, body) => {
    const supabase = makeSupabase({});
    allowManager(supabase);

    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("creates a trimmed, server-scoped bin and returns 201", async () => {
    const created = {
      id: "bin-a",
      code: "A-01",
      zone: "Reds",
      capacity: 24,
      priority: 2,
      sort_order: 0,
    };
    const supabase = makeSupabase({
      bins: { data: created, error: null },
    });
    allowManager(supabase);

    const response = await POST(
      postRequest({
        code: "  A-01  ",
        zone: "  Reds  ",
        capacity: 24,
        priority: 2,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(supabase.operations.bins).toContainEqual([
      "insert",
      {
        restaurant_id: "restaurant-a",
        code: "A-01",
        zone: "Reds",
        capacity: 24,
        priority: 2,
      },
    ]);
  });

  it("maps a duplicate code to duplicate_bin_code", async () => {
    const error = { code: "23505", message: "duplicate secret detail" };
    const supabase = makeSupabase({ bins: { data: null, error } });
    allowManager(supabase);

    const response = await POST(postRequest({ code: "A-01" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "duplicate_bin_code",
        message: "A bin with that code already exists.",
      },
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("redacts and captures other insert failures", async () => {
    const error = { code: "XX000", message: "password=secret" };
    const supabase = makeSupabase({ bins: { data: null, error } });
    allowManager(supabase);

    const response = await POST(postRequest({ code: "A-01" }));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(mockCaptureException).toHaveBeenCalledWith(new Error("bins create failed"), {
      tags: { surface: "bins", phase: "create" },
      extra: { restaurantId: "restaurant-a" },
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("secret");
    expect(console.error).toHaveBeenCalledWith("bins create failed");
  });
});
