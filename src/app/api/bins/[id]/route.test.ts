import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { BIN_ID, makeSupabase, PARAMS, patchRequest } from "./route.test-helpers";

const mockRequireRole = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { PATCH } = await import("./route");

function allowManager(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireRole.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "manager",
  });
}

const RENAMED_BIN = {
  id: BIN_ID,
  code: "R-04",
  zone: null,
  capacity: null,
  priority: 0,
  sort_order: 0,
  retired_at: null,
};
const CURRENT_BIN = {
  code: "R-03",
  zone: "Old zone",
  capacity: 8,
  priority: 1,
  retired_at: null,
};

function expectSafeCapture(
  call: number,
  message: string,
  phase: string,
) {
  expect(mockCaptureException).toHaveBeenNthCalledWith(
    call,
    expect.objectContaining({ message }),
    {
      tags: { surface: "bins", phase },
      extra: { restaurantId: "restaurant-a", binId: BIN_ID },
    },
  );
}

function expectTelemetryRedacted(secret: string) {
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    secret,
  );
  expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(secret);
}

describe("PATCH /api/bins/[id]", () => {
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

      const response = await PATCH(patchRequest({ priority: 3 }), PARAMS());

      expect(response.status).toBe(status);
      expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
      expect(supabase.from).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid JSON", "{not json"],
    ["empty body", {}],
    ["unknown fields", { restaurant_id: "restaurant-b" }],
    ["blank code", { code: "   " }],
    ["oversized zone", { zone: "x".repeat(101) }],
    ["non-positive capacity", { capacity: -1 }],
    ["fractional priority", { priority: 2.5 }],
    ["invalid retired_at", { retired_at: "yesterday" }],
  ])("returns 400 for %s before updating", async (_name, body) => {
    const supabase = makeSupabase({});
    allowManager(supabase);

    const response = await PATCH(patchRequest(body), PARAMS());

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed bin id", async () => {
    const supabase = makeSupabase({});
    allowManager(supabase);

    const response = await PATCH(patchRequest({ priority: 1 }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("updates with explicit id and tenant scope", async () => {
    const updated = {
      id: BIN_ID,
      code: "A-01",
      zone: "Reserve",
      capacity: 18,
      priority: 3,
      sort_order: 0,
      retired_at: null,
    };
    const supabase = makeSupabase({
      bins: [{ data: updated, error: null }],
    });
    allowManager(supabase);

    const response = await PATCH(
      patchRequest({ zone: "  Reserve  ", capacity: 18, priority: 3 }),
      PARAMS(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updated);
    expect(supabase.operations.bins[0]).toEqual([
      ["update", { zone: "Reserve", capacity: 18, priority: 3 }],
      ["eq", "id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
      [
        "select",
        "id, code, zone, capacity, priority, sort_order, retired_at",
      ],
    ]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the explicit tenant scope finds no bin", async () => {
    const supabase = makeSupabase({
      bins: [{ data: null, error: null }],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ priority: 3 }), PARAMS());

    expect(response.status).toBe(404);
    expect(supabase.operations.bins[0]).toContainEqual([
      "eq",
      "restaurant_id",
      "restaurant-a",
    ]);
  });

  it("mirrors a changed code to tenant-scoped inventory rows", async () => {
    const updated = {
      id: BIN_ID,
      code: "R-04",
      zone: "Reds",
      capacity: 12,
      priority: 0,
      sort_order: 0,
      retired_at: null,
    };
    const supabase = makeSupabase({
      bins: [
        { data: { code: "R-03" }, error: null },
        { data: updated, error: null },
      ],
      inventory_items: [{ data: null, error: null }],
    });
    allowManager(supabase);

    const response = await PATCH(
      patchRequest({ code: "  R-04  " }),
      PARAMS(),
    );

    expect(response.status).toBe(200);
    expect(supabase.operations.bins[0]).toEqual([
      ["select", "code, zone, capacity, priority, retired_at"],
      ["eq", "id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
    ]);
    expect(supabase.operations.bins[1]).toEqual([
      ["update", { code: "R-04" }],
      ["eq", "id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
      ["eq", "code", "R-03"],
      [
        "select",
        "id, code, zone, capacity, priority, sort_order, retired_at",
      ],
    ]);
    expect(supabase.operations.inventory_items[0]).toEqual([
      ["update", { bin_location: "R-04" }],
      ["eq", "bin_id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
    ]);
  });

  it("maps duplicate codes to duplicate_bin_code without mirroring", async () => {
    const error = { code: "23505", message: "duplicate secret detail" };
    const supabase = makeSupabase({
      bins: [
        { data: { code: "R-03" }, error: null },
        { data: null, error },
      ],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ code: "R-04" }), PARAMS());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("duplicate_bin_code");
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("returns 404 when a rename pre-read cannot find a tenant bin", async () => {
    const supabase = makeSupabase({
      bins: [{ data: null, error: null }],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ code: "R-04" }), PARAMS());

    expect(response.status).toBe(404);
    expect(supabase.operations.bins[0]).toEqual([
      ["select", "code, zone, capacity, priority, retired_at"],
      ["eq", "id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
    ]);
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("redacts a rename pre-read failure from logs and Sentry", async () => {
    const error = { code: "XX000", message: "password=lookup-secret" };
    const supabase = makeSupabase({
      bins: [{ data: null, error }],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ code: "R-04" }), PARAMS());

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Bin code lookup failed.");
    expectSafeCapture(1, "Bin code lookup failed.", "read-code");
    expect(mockCaptureException).not.toHaveBeenCalledWith(error, expect.anything());
    expectTelemetryRedacted("lookup-secret");
  });

  it("returns a conflict when the optimistic old-code predicate misses", async () => {
    const supabase = makeSupabase({
      bins: [
        { data: { code: "R-03" }, error: null },
        { data: null, error: null },
      ],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ code: "R-04" }), PARAMS());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("bin_changed");
    expect(supabase.operations.bins[1]).toContainEqual([
      "eq",
      "code",
      "R-03",
    ]);
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it("redacts and captures an update failure", async () => {
    const error = { code: "XX000", message: "password=secret" };
    const supabase = makeSupabase({
      bins: [{ data: null, error }],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ priority: 3 }), PARAMS());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Bin update failed.");
    expectSafeCapture(1, "Bin update failed.", "update");
    expect(mockCaptureException).not.toHaveBeenCalledWith(error, expect.anything());
    expectTelemetryRedacted("password=secret");
  });

  it("returns a redacted 500 when the legacy-code mirror fails", async () => {
    const mirrorError = { code: "XX000", message: "password=secret" };
    const supabase = makeSupabase({
      bins: [
        { data: CURRENT_BIN, error: null },
        { data: RENAMED_BIN, error: null },
        { data: { id: BIN_ID }, error: null },
      ],
      inventory_items: [{ data: null, error: mirrorError }],
    });
    allowManager(supabase);

    const response = await PATCH(
      patchRequest({
        code: "R-04",
        zone: null,
        capacity: null,
        priority: 2,
        retired_at: null,
      }),
      PARAMS(),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("secret");
    expect(supabase.operations.inventory_items[0]).toEqual([
      ["update", { bin_location: "R-04" }],
      ["eq", "bin_id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
    ]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Bin code mirror failed.");
    expectSafeCapture(1, "Bin code mirror failed.", "mirror-code");
    expect(mockCaptureException).not.toHaveBeenCalledWith(
      mirrorError,
      expect.anything(),
    );
    expectTelemetryRedacted("password=secret");
    expect(supabase.operations.bins[2]).toEqual([
      [
        "update",
        {
          code: "R-03",
          zone: "Old zone",
          capacity: 8,
          priority: 1,
          retired_at: null,
        },
      ],
      ["eq", "id", BIN_ID],
      ["eq", "restaurant_id", "restaurant-a"],
      ["eq", "code", "R-04"],
      ["is", "zone", null],
      ["is", "capacity", null],
      ["eq", "priority", 2],
      ["is", "retired_at", null],
      ["select", "id"],
    ]);
  });

  it("captures a rollback predicate miss after a mirror failure", async () => {
    const mirrorError = { code: "XX000", message: "mirror secret" };
    const supabase = makeSupabase({
      bins: [
        { data: { code: "R-03" }, error: null },
        { data: RENAMED_BIN, error: null },
        { data: null, error: null },
      ],
      inventory_items: [{ data: null, error: mirrorError }],
    });
    allowManager(supabase);

    const response = await PATCH(patchRequest({ code: "R-04" }), PARAMS());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("mirror secret");
    expect(console.error).toHaveBeenNthCalledWith(1, "Bin code mirror failed.");
    expect(console.error).toHaveBeenNthCalledWith(2, "Bin code rollback failed.");
    expectSafeCapture(1, "Bin code mirror failed.", "mirror-code");
    expectSafeCapture(2, "Bin code rollback failed.", "rollback-code");
    expectTelemetryRedacted("secret");
  });
});
