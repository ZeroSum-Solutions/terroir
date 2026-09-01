// P1 slice 1 — GET /api/search, the unified tier-1 endpoint the palette will
// consume. Merge/rank/dedupe SEMANTICS are unit-tested in
// src/lib/unified-search/merge.test.ts; what this suite pins is the route's
// wiring and its survival posture:
//
//   - the free-text cellar pass matches region/varietal/country too (the D4
//     bug fix — the old route's OR spans only name+producer);
//   - scope=cellar makes no catalogue calls at all;
//   - catalogue RPCs and the links lookup DEGRADE, never 500: migrations do
//     not ride deploys (AGENTS #7), so this code will be live before 0145's
//     links table and 0146's xwines_search exist in production, and a search
//     that answers from the cellar alone beats one that breaks outright.
//     Degradation is reported to Sentry, not swallowed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException }));

const { GET } = await import("./route");

type Row = Record<string, unknown>;

function makeSupabase(options?: {
  wines?: Row[];
  canonical?: Row[];
  links?: Row[];
  linksError?: { message: string } | null;
  lwin?: Row[];
  lwinError?: { message: string } | null;
  xwines?: Row[];
  xwinesError?: { message: string } | null;
  inventory?: Row[];
  inventoryError?: { message: string } | null;
  fuzzy?: Array<{ wine_id: string; score: number }>;
  lwinCatalog?: Row[];
  xwinesCatalog?: Row[];
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  function makeChain(table: string) {
    const rows =
      table === "canonical_wines"
        ? (options?.canonical ?? [])
        : table === "lwin_xwines_links"
          ? (options?.links ?? [])
          : table === "inventory_items"
            ? (options?.inventory ?? [])
            : table === "lwin_catalog"
              ? (options?.lwinCatalog ?? [])
              : table === "xwines_catalog"
                ? (options?.xwinesCatalog ?? [])
                : (options?.wines ?? []);
    const error =
      table === "lwin_xwines_links"
        ? (options?.linksError ?? null)
        : table === "inventory_items"
          ? (options?.inventoryError ?? null)
          : null;
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "or", "order", "limit", "overlaps"]) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method: `${table}.${method}`, args });
        return chain;
      };
    }
    chain.then = (resolve: (v: { data: Row[] | null; error: unknown }) => unknown) =>
      resolve(error ? { data: null, error } : { data: rows, error: null });
    return chain;
  }
  const rpc = vi.fn(async (name: string) => {
    if (name === "search_wines_fuzzy") return { data: options?.fuzzy ?? [], error: null };
    if (name === "lwin_search")
      return options?.lwinError
        ? { data: null, error: options.lwinError }
        : { data: options?.lwin ?? [], error: null };
    if (name === "xwines_search")
      return options?.xwinesError
        ? { data: null, error: options.xwinesError }
        : { data: options?.xwines ?? [], error: null };
    return { data: [], error: null };
  });
  return { supabase: { from: vi.fn((table: string) => makeChain(table)), rpc }, calls };
}

function request(params: string): NextRequest {
  return new NextRequest(`http://localhost/api/search?${params}`);
}

const LWIN_ROW = {
  lwin_id: "1234567",
  display_name: "Penfolds, Koonunga Hill, South Australia",
  producer: "Penfolds",
  region: "South Australia",
  country: "Australia",
  colour: "Red",
  type: "Wine",
};

const XWINES_ROW = {
  wine_id: 101,
  name: "Koonunga Hill",
  winery_name: "Penfolds",
  region_name: "South Australia",
  country: "Australia",
  type: "Red",
  image_url: null,
  image_kind: null,
  score: 0.8,
};

describe("GET /api/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes through the auth failure response", async () => {
    const denied = NextResponse.json({ error: "no" }, { status: 401 });
    mockRequireMembership.mockResolvedValue(denied);
    const res = await GET(request("q=margaux"));
    expect(res.status).toBe(401);
  });

  it("returns empty results for a sub-2-character query without touching the database", async () => {
    const { supabase } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=m"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("free-text matches region, varietal and country — the D4 bug fix", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(request("q=chablis"));
    const orCall = calls.find((c) => c.method === "wines.or");
    expect(orCall).toBeDefined();
    const pattern = String(orCall!.args[0]);
    for (const column of ["name", "producer", "region", "varietal", "country"]) {
      expect(pattern).toContain(`${column}.ilike.`);
    }
  });

  it("merges the accepted-link catalogue pair into one deduped row", async () => {
    const { supabase } = makeSupabase({
      lwin: [LWIN_ROW],
      xwines: [XWINES_ROW],
      links: [{ lwin_id: "1234567", xwines_wine_id: 101 }],
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=koonunga"));
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      kind: "catalogue",
      provenance: "lwin+xwines",
      deduped: true,
      lwinId: "1234567",
      xwinesWineId: 101,
    });
  });

  it("makes no catalogue calls under scope=cellar", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: "w-1", name: "Koonunga Hill", producer: "Penfolds", vintage: 2019, varietal: null, region: null, country: null, colour: null, hero_image_url: null, is_eightysixed: false, canonical_wine_id: null }],
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=koonunga&scope=cellar"));
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].kind).toBe("cellar");
    const rpcNames = supabase.rpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).not.toContain("lwin_search");
    expect(rpcNames).not.toContain("xwines_search");
  });

  it("sums bottle counts and carries the most recent bin on cellar rows", async () => {
    // Slice 2b (D4: cellar rows add qty/bin). Two inventory rows for the same
    // wine sum; the bin shown is the most recently stocked one, which is the
    // first row because the route orders by added_at descending.
    const { supabase } = makeSupabase({
      wines: [{ id: "w-1", name: "Koonunga Hill", producer: "Penfolds", vintage: 2019, varietal: null, region: null, country: null, colour: null, hero_image_url: null, is_eightysixed: false, canonical_wine_id: null }],
      inventory: [
        { wine_id: "w-1", quantity: 2, bin_location: "A4" },
        { wine_id: "w-1", quantity: 1, bin_location: "B2" },
      ],
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=koonunga&scope=cellar"));
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ kind: "cellar", quantity: 3, bin: "A4" });
  });

  it("degrades availability to unknown — never a zero-stock claim — when inventory can't be read", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: "w-1", name: "Koonunga Hill", producer: "Penfolds", vintage: 2019, varietal: null, region: null, country: null, colour: null, hero_image_url: null, is_eightysixed: false, canonical_wine_id: null }],
      inventoryError: { message: "read timed out" },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=koonunga&scope=cellar"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ kind: "cellar", quantity: null, bin: null });
    expect(captureException).toHaveBeenCalled();
  });

  it("degrades to cellar-only when a catalogue RPC is unavailable, and reports it", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: "w-1", name: "Koonunga Hill", producer: "Penfolds", vintage: 2019, varietal: null, region: null, country: null, colour: null, hero_image_url: null, is_eightysixed: false, canonical_wine_id: null }],
      lwinError: { message: "function does not exist" },
      xwinesError: { message: "function does not exist" },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=koonunga"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].kind).toBe("cellar");
    expect(captureException).toHaveBeenCalled();
  });

  it("degrades to no dedupe claims when the links table is unavailable, and reports it", async () => {
    const { supabase } = makeSupabase({
      lwin: [LWIN_ROW],
      xwines: [XWINES_ROW],
      linksError: { message: "relation does not exist" },
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(request("q=koonunga"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { deduped: boolean }) => r.deduped === false)).toBe(true);
    expect(captureException).toHaveBeenCalled();
  });
});

// P1 slice 3b — the parser (slice 3a) reaches the endpoint.
//
// The defect this closes, observed live on 2026-08-31: the tier-1 matcher is
// loose enough that "a crisp white from Portugal" returns rows whose names
// merely contain one of those words, so a descriptive question got answered
// with noise instead of either real matches or an honest miss.
describe("GET /api/search — typed search (P1 slice 3b)", () => {
  beforeEach(() => vi.clearAllMocks());

  const q = (text: string) => request(`q=${encodeURIComponent(text)}`);

  it("filters the catalogue on the facts asked for instead of trigram-matching them", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(q("a crisp white from Portugal"));

    // Nothing is left to trigram-match: the whole query was facts.
    expect(supabase.rpc).not.toHaveBeenCalledWith("lwin_search", expect.anything());
    expect(supabase.rpc).not.toHaveBeenCalledWith("xwines_search", expect.anything());

    const lwinIn = calls.filter((c) => c.method === "lwin_catalog.in");
    expect(lwinIn).toContainEqual({ method: "lwin_catalog.in", args: ["country", ["Portugal"]] });
    expect(lwinIn).toContainEqual({ method: "lwin_catalog.in", args: ["colour", ["White"]] });
    // X-Wines spells the same colour on a different column.
    expect(calls).toContainEqual({ method: "xwines_catalog.in", args: ["type", ["White"]] });
  });

  it("drops LWIN from a sparkling query rather than answering it with still wine", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(q("sparkling from France"));

    expect(calls.some((c) => c.method.startsWith("lwin_catalog."))).toBe(false);
    expect(calls).toContainEqual({ method: "xwines_catalog.in", args: ["type", ["Sparkling"]] });
  });

  it("still searches LWIN for a vintage, which it models at the wine's grain", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(q("2016 Bordeaux"));

    expect(calls.some((c) => c.method.startsWith("lwin_catalog."))).toBe(true);
    expect(calls).toContainEqual({ method: "xwines_catalog.overlaps", args: ["vintages", [2016]] });
    expect(calls).toContainEqual({ method: "wines.in", args: ["vintage", [2016]] });
  });

  it("narrows the tenant's own cellar by the same facts", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(q("Portuguese white"));

    expect(calls).toContainEqual({ method: "wines.in", args: ["country", ["Portugal"]] });
    // The cellar spells its colours in lower case.
    expect(calls).toContainEqual({ method: "wines.in", args: ["colour", ["white"]] });
  });

  it("leaves a query it recognises nothing in on the trigram path, unchanged", async () => {
    const { supabase, calls } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(q("margaux"));

    expect(supabase.rpc).toHaveBeenCalledWith("lwin_search", { p_query: "margaux", p_limit: 20 });
    expect(calls.some((c) => c.method.startsWith("lwin_catalog."))).toBe(false);
  });

  it("searches what was asked for, not the words wrapped around it", async () => {
    const { supabase } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    await GET(q("show me some chablis please"));
    expect(supabase.rpc).toHaveBeenCalledWith("lwin_search", { p_query: "chablis", p_limit: 20 });
  });

  it("answers a query with nothing searchable in it honestly, rather than with noise", async () => {
    const { supabase } = makeSupabase();
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(q("something nice please"));
    expect(await res.json()).toEqual({ results: [] });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns the filtered catalogue rows as results", async () => {
    const { supabase } = makeSupabase({
      xwinesCatalog: [
        { ...XWINES_ROW, wine_id: 501, name: "Alvarinho", country: "Portugal", type: "White", body: "Light-bodied" },
      ],
    });
    mockRequireMembership.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await GET(q("a crisp white from Portugal"));
    const { results } = await res.json();
    expect(results.map((r: { name: string }) => r.name)).toContain("Alvarinho");
  });
});
