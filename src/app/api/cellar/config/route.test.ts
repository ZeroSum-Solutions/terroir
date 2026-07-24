import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
const mockCaptureException = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { GET } = await import("./route");

function makeSupabase(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ limit }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from, select, eq, limit, maybeSingle };
}

function allow(supabase: ReturnType<typeof makeSupabase>) {
  mockRequireMembership.mockResolvedValue({
    supabase,
    restaurantId: "restaurant-a",
    user: { id: "user-a" },
    role: "staff",
  });
}

describe("GET /api/cellar/config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([401, 403])(
    "returns an auth denial before database access (%s)",
    async (status) => {
      const supabase = makeSupabase({ data: null, error: null });
      mockRequireMembership.mockResolvedValue(
        NextResponse.json({ error: "denied" }, { status }),
      );

      const response = await GET();

      expect(response.status).toBe(status);
      expect(supabase.from).not.toHaveBeenCalled();
    },
  );

  it("returns the current configuration", async () => {
    const config = { id: "config-a", rows: 10, columns: 12 };
    const supabase = makeSupabase({ data: config, error: null });
    allow(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(config);
    expect(supabase.from).toHaveBeenCalledWith("cellar_config");
  });

  it("preserves 200 null when no configuration exists", async () => {
    const supabase = makeSupabase({ data: null, error: null });
    allow(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("redacts and captures a real database failure", async () => {
    const error = { message: "password=super-secret", code: "XX000" };
    const supabase = makeSupabase({ data: null, error });
    allow(supabase);

    const response = await GET();
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to fetch cellar configuration.",
      },
    });
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("XX000");
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { surface: "cellar-config", phase: "fetch" },
      extra: { restaurantId: "restaurant-a" },
    });
  });
});
