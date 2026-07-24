import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const auth = vi.hoisted(() => ({
  requireMembership: vi.fn(),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) =>
    auth.requireMembership(...args),
  requireRole: (...args: unknown[]) => auth.requireRole(...args),
}));
vi.mock("@/lib/wine-intelligence/enrich", () => ({
  enrichWine: vi.fn(() => ({
    drinkWindowStart: null,
    drinkWindowEnd: null,
    peakYear: null,
    ratingSource: null,
    reviewExcerpt: null,
    servingTempMin: null,
    servingTempMax: null,
    servingTempLabel: null,
    decantMinutes: null,
  })),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST: ADD_WINE } = await import("./route");
const { POST: BATCH_SECTION } = await import("./batch-section/route");
const { GET: GRID } = await import("./grid/route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function allowRole(supabase: unknown) {
  auth.requireRole.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    role: "owner",
  });
}

function allowMembership(supabase: unknown) {
  auth.requireMembership.mockResolvedValue({
    supabase,
    restaurantId: RESTAURANT_ID,
    role: "staff",
  });
}

describe("cellar collection request boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      name: "add wine",
      call: (req: NextRequest) => ADD_WINE(req),
    },
    {
      name: "batch section",
      call: (req: NextRequest) => BATCH_SECTION(req),
    },
  ])("$name authenticates before reading the request body", async ({
    call,
  }) => {
    const denial = NextResponse.json(
      { error: { code: "unauthorized", message: "Unauthorized" } },
      { status: 401 },
    );
    auth.requireRole.mockResolvedValue(denial);
    const text = vi.fn();
    const json = vi.fn();

    const response = await call({ text, json } as unknown as NextRequest);

    expect(response).toBe(denial);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "add wine",
      call: (req: NextRequest) => ADD_WINE(req),
    },
    {
      name: "batch section",
      call: (req: NextRequest) => BATCH_SECTION(req),
    },
  ])("$name returns invalid_json for malformed JSON", async ({ call }) => {
    allowRole({});

    const response = await call(request("/api/cellar", "{not-json"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_json", message: "Invalid JSON." },
    });
  });

  it("add wine rejects unknown fields before provider work", async () => {
    const rpc = vi.fn(() => {
      throw new Error("provider must not run");
    });
    allowRole({ rpc });

    const response = await ADD_WINE(
      request("/api/cellar", {
        name: "Reserve",
        producer: "Domaine Test",
        restaurant_id: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("add wine redacts an invalid wine ID returned by the provider", async () => {
    allowRole({
      rpc: vi.fn(async () => ({ data: ["not-a-uuid"], error: null })),
      from: vi.fn(() => {
        throw new Error("inventory must not run");
      }),
    });

    const response = await ADD_WINE(
      request("/api/cellar", {
        name: "Reserve",
        producer: "Domaine Test",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });

  it("batch section rejects duplicate wine IDs before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    allowRole({ from });

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID, WINE_ID],
        section: "Reserve",
      }),
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("batch section rejects unknown fields before database work", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not run");
    });
    allowRole({ from });

    const response = await BATCH_SECTION(
      request("/api/cellar/batch-section", {
        wine_ids: [WINE_ID],
        section: "Reserve",
        restaurant_id: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "grid",
      setup: () => {
        const from = vi.fn(() => {
          throw new Error("database secret");
        });
        allowMembership({ from });
        return () => GRID();
      },
    },
    {
      name: "batch section",
      setup: () => {
        const from = vi.fn(() => {
          throw new Error("database secret");
        });
        allowRole({ from });
        return () =>
          BATCH_SECTION(
            request("/api/cellar/batch-section", {
              wine_ids: [WINE_ID],
              section: "Reserve",
            }),
          );
      },
    },
  ])("$name redacts unexpected provider throws", async ({ setup }) => {
    const call = setup();

    const response = await call();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  });
});
