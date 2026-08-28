import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /api/wine-lists/[id]/clone tests.
 *
 * SCALE: the route used to insert one `wine_list_sections` row per
 * source section (an N+1 for an N-section list) inside a loop that also
 * inserted that section's items separately. It now inserts every cloned
 * section in one call and every cloned item (across all sections) in
 * one call — two writes total instead of up to 2N.
 */

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { POST } = await import("./route");

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): NextRequest {
  return new Request("http://localhost/api/wine-lists/list-1/clone", {
    method: "POST",
  }) as unknown as NextRequest;
}

type SourceItem = {
  id: string;
  wine_id: string;
  bottle_price: number | null;
  glass_price: number | null;
  glass_pour_ml: number | null;
  pour_size_mode: string | null;
  position: number;
  is_available: boolean | null;
  tasting_note: string | null;
};

function sourceItem(overrides: Partial<SourceItem>): SourceItem {
  return {
    id: "item-1",
    wine_id: "wine-1",
    bottle_price: 60,
    glass_price: 12,
    glass_pour_ml: 150,
    pour_size_mode: "bottle_only",
    position: 0,
    is_available: true,
    tasting_note: null,
    ...overrides,
  };
}

/**
 * Builds a supabase mock for the clone route's call sequence:
 *  1. from('wine_lists').select(...).eq().eq().single()  → source list
 *  2. from('wine_list_sections').select(...).eq().order() → source sections + items
 *  3. from('wine_lists').insert(...).select('id').single() → clone list
 *  4. from('wine_list_sections').insert([...])  → batched section clone
 *  5. from('wine_list_items').insert([...])     → batched item clone
 * (a 6th from('wine_lists').delete() cleanup call may follow on failure)
 */
function buildSupabase(opts: {
  sourceList: { name: string; description: string | null; template: string | null } | null;
  sourceSections: Array<{
    id: string;
    name: string;
    position: number;
    wine_list_items?: SourceItem[];
  }>;
  cloneListId?: string;
  sectionsInsertError?: unknown;
  itemsInsertError?: unknown;
}) {
  const sectionInserts: unknown[] = [];
  const itemInserts: unknown[] = [];
  const deletes: unknown[] = [];
  const cloneListId = opts.cloneListId ?? "clone-list-1";

  const chain = (resolveValue: { data: unknown; error: unknown }) => {
    const obj: Record<string, unknown> = {};
    const self = () => obj;
    obj.select = self;
    obj.eq = self;
    obj.order = self;
    obj.single = () => Promise.resolve(resolveValue);
    obj.then = (resolve: (v: unknown) => void) => resolve(resolveValue);
    return obj;
  };

  const supabase = {
    from: (table: string) => {
      if (table === "wine_lists") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve(
                    opts.sourceList
                      ? { data: opts.sourceList, error: null }
                      : { data: null, error: { message: "not found" } },
                  ),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: cloneListId }, error: null }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: () => {
                deletes.push(true);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          }),
        };
      }
      if (table === "wine_list_sections") {
        return {
          select: () => ({
            eq: () => ({
              order: () =>
                Promise.resolve({ data: opts.sourceSections, error: null }),
            }),
          }),
          insert: (payload: unknown) => {
            sectionInserts.push(payload);
            return chain({
              data: null,
              error: opts.sectionsInsertError ?? null,
            });
          },
        };
      }
      if (table === "wine_list_items") {
        return {
          insert: (payload: unknown) => {
            itemInserts.push(payload);
            return chain({ data: null, error: opts.itemsInsertError ?? null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { supabase, sectionInserts, itemInserts, deletes, cloneListId };
}

describe("POST /api/wine-lists/[id]/clone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when requireRole returns a NextResponse", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    );
    const res = await POST(makeRequest(), makeParams("list-1"));
    expect(res.status).toBe(401);
  });

  it("404s when the source list isn't found for this restaurant", async () => {
    const { supabase } = buildSupabase({ sourceList: null, sourceSections: [] });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const res = await POST(makeRequest(), makeParams("list-1"));
    expect(res.status).toBe(404);
  });

  it("clones a multi-section list with exactly one sections insert and one items insert", async () => {
    const sections = [
      {
        id: "src-sec-a",
        name: "Reds",
        position: 0,
        wine_list_items: [
          sourceItem({ id: "item-a1", wine_id: "wine-a1", position: 0 }),
          sourceItem({ id: "item-a2", wine_id: "wine-a2", position: 1 }),
        ],
      },
      {
        id: "src-sec-b",
        name: "Whites",
        position: 1,
        wine_list_items: [
          sourceItem({ id: "item-b1", wine_id: "wine-b1", position: 0 }),
        ],
      },
      {
        id: "src-sec-c",
        name: "Empty section",
        position: 2,
        wine_list_items: [],
      },
    ];
    const { supabase, sectionInserts, itemInserts } = buildSupabase({
      sourceList: { name: "Main List", description: null, template: "classic" },
      sourceSections: sections,
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST(makeRequest(), makeParams("list-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe("clone-list-1");

    // Exactly one round trip per table, regardless of section count.
    expect(sectionInserts).toHaveLength(1);
    expect(itemInserts).toHaveLength(1);

    const clonedSections = sectionInserts[0] as Array<{
      id: string;
      wine_list_id: string;
      name: string;
      position: number;
    }>;
    expect(clonedSections).toHaveLength(3);
    expect(clonedSections.map((s) => s.name)).toEqual([
      "Reds",
      "Whites",
      "Empty section",
    ]);
    expect(clonedSections.every((s) => s.wine_list_id === "clone-list-1")).toBe(true);
    // Every cloned section gets a distinct id.
    expect(new Set(clonedSections.map((s) => s.id)).size).toBe(3);

    const clonedItems = itemInserts[0] as Array<{
      section_id: string;
      wine_id: string;
      restaurant_id: string;
    }>;
    expect(clonedItems).toHaveLength(3);
    expect(clonedItems.every((i) => i.restaurant_id === "r-1")).toBe(true);
    // Items land under their own section's new id, not a shared one.
    const redsId = clonedSections[0].id;
    const whitesId = clonedSections[1].id;
    expect(clonedItems.filter((i) => i.section_id === redsId)).toHaveLength(2);
    expect(clonedItems.filter((i) => i.section_id === whitesId)).toHaveLength(1);
  });

  it("clones a list with no sections without inserting empty batches", async () => {
    const { supabase, sectionInserts, itemInserts } = buildSupabase({
      sourceList: { name: "Empty List", description: null, template: "classic" },
      sourceSections: [],
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST(makeRequest(), makeParams("list-1"));
    expect(res.status).toBe(200);
    expect(sectionInserts).toHaveLength(0);
    expect(itemInserts).toHaveLength(0);
  });

  it("cleans up the partial clone and 500s when the batched sections insert fails", async () => {
    const { supabase, deletes, itemInserts } = buildSupabase({
      sourceList: { name: "Main List", description: null, template: "classic" },
      sourceSections: [{ id: "src-sec-a", name: "Reds", position: 0, wine_list_items: [] }],
      sectionsInsertError: { message: "insert failed" },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST(makeRequest(), makeParams("list-1"));
    expect(res.status).toBe(500);
    expect(deletes).toHaveLength(1);
    expect(itemInserts).toHaveLength(0);
  });

  it("cleans up the partial clone and 500s when the batched items insert fails", async () => {
    const { supabase, deletes } = buildSupabase({
      sourceList: { name: "Main List", description: null, template: "classic" },
      sourceSections: [
        {
          id: "src-sec-a",
          name: "Reds",
          position: 0,
          wine_list_items: [sourceItem({})],
        },
      ],
      itemsInsertError: { message: "insert failed" },
    });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const res = await POST(makeRequest(), makeParams("list-1"));
    expect(res.status).toBe(500);
    expect(deletes).toHaveLength(1);
  });
});
