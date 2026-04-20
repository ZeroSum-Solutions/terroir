import { describe, it, expect, vi, beforeEach } from "vitest";

// next/headers cookies() stub — we only care about parseActiveRestaurantCookie
// and signActiveRestaurantCookie here. Keep it simple.
const mockCookieGet = vi.fn();
const mockCookieSet = vi.fn();
const mockCookieDelete = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => mockCookieGet(name),
    set: (...args: unknown[]) => mockCookieSet(...args),
    delete: (...args: unknown[]) => mockCookieDelete(...args),
  })),
}));

const {
  signActiveRestaurantCookie,
  parseActiveRestaurantCookie,
  readActiveRestaurantFromCookie,
  setActiveRestaurant,
  clearActiveRestaurant,
} = await import("./active-restaurant");

describe("active-restaurant cookie signing", () => {
  it("sign + parse is a round-trip for the same secret", () => {
    const raw = signActiveRestaurantCookie("r-42");
    expect(raw).toMatch(/^r-42\./);
    expect(parseActiveRestaurantCookie(raw)).toBe("r-42");
  });

  it("rejects a tampered id half", () => {
    const raw = signActiveRestaurantCookie("r-42");
    const [, mac] = raw.split(".");
    const tampered = `r-99.${mac}`;
    expect(parseActiveRestaurantCookie(tampered)).toBeNull();
  });

  it("rejects a tampered signature half", () => {
    const raw = signActiveRestaurantCookie("r-42");
    const [id] = raw.split(".");
    const tampered = `${id}.not-a-valid-mac`;
    expect(parseActiveRestaurantCookie(tampered)).toBeNull();
  });

  it("returns null for empty / missing cookie values", () => {
    expect(parseActiveRestaurantCookie(undefined)).toBeNull();
    expect(parseActiveRestaurantCookie(null)).toBeNull();
    expect(parseActiveRestaurantCookie("")).toBeNull();
    expect(parseActiveRestaurantCookie("noseparator")).toBeNull();
    expect(parseActiveRestaurantCookie(".onlysignature")).toBeNull();
  });
});

describe("readActiveRestaurantFromCookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no cookie is set", async () => {
    mockCookieGet.mockReturnValue(undefined);
    const out = await readActiveRestaurantFromCookie(["r1", "r2"]);
    expect(out).toBeNull();
  });

  it("returns the id when the cookie is valid and the user is a member", async () => {
    mockCookieGet.mockReturnValue({
      value: signActiveRestaurantCookie("r2"),
    });
    const out = await readActiveRestaurantFromCookie(["r1", "r2"]);
    expect(out).toBe("r2");
  });

  it("returns null when the cookie names a restaurant the user is NOT a member of", async () => {
    mockCookieGet.mockReturnValue({
      value: signActiveRestaurantCookie("r-removed"),
    });
    const out = await readActiveRestaurantFromCookie(["r1", "r2"]);
    expect(out).toBeNull();
  });

  it("returns null when the signature is wrong", async () => {
    mockCookieGet.mockReturnValue({ value: "r1.wrong" });
    const out = await readActiveRestaurantFromCookie(["r1", "r2"]);
    expect(out).toBeNull();
  });
});

describe("setActiveRestaurant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSupabase(row: { restaurant_id: string } | null, error?: unknown) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: row, error }),
              }),
            }),
          }),
        }),
      }),
    };
  }

  it("refuses to set a restaurant the user is not a member of", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = mockSupabase(null) as any;
    const result = await setActiveRestaurant(supabase, "u1", "r-sneaky");
    expect(result.ok).toBe(false);
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it("writes a signed cookie when membership check passes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = mockSupabase({ restaurant_id: "r1" }) as any;
    const result = await setActiveRestaurant(supabase, "u1", "r1");
    expect(result.ok).toBe(true);
    expect(mockCookieSet).toHaveBeenCalledTimes(1);
    const [name, value, opts] = mockCookieSet.mock.calls[0];
    expect(name).toBe("active_restaurant_id");
    expect(value).toMatch(/^r1\./);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });
});

describe("clearActiveRestaurant", () => {
  it("deletes the cookie", async () => {
    await clearActiveRestaurant();
    expect(mockCookieDelete).toHaveBeenCalledWith("active_restaurant_id");
  });
});
