import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * revalidateAutoEightysixedWines tests.
 *
 * SCALE: wine_published_list_slugs has no batched (array-of-ids) RPC
 * variant, so a pour/reconcile that auto-86's N wines still makes N RPC
 * calls — but they used to run one at a time (await inside a for loop),
 * serializing N round-trip latencies. They now fire concurrently via
 * Promise.all.
 */

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

const { revalidateAutoEightysixedWines } = await import(
  "./auto-eightysix-revalidation"
);

function eventsChain(events: Array<{ wine_id: string }>) {
  const self: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "gte"]) {
    self[method] = () => self;
  }
  self.in = () => Promise.resolve({ data: events, error: null });
  return self;
}

describe("revalidateAutoEightysixedWines", () => {
  beforeEach(() => {
    mockRevalidatePath.mockClear();
  });

  it("no-ops without touching the database when no wines were touched", async () => {
    const supabase = {
      from: vi.fn(),
      rpc: vi.fn(),
    };

    await revalidateAutoEightysixedWines({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      restaurantId: "r-1",
      touchedWineIds: [],
      sinceTs: "2026-01-01T00:00:00.000Z",
    });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("issues every slug lookup concurrently instead of one at a time", async () => {
    const wineIds = ["wine-a", "wine-b", "wine-c"];
    let rpcCallCount = 0;
    const rpcResolvers: Array<() => void> = [];

    const supabase = {
      from: () => eventsChain(wineIds.map((id) => ({ wine_id: id }))),
      rpc: (_name: string, args: { p_wine_id: string }) => {
        rpcCallCount += 1;
        return new Promise((resolve) => {
          rpcResolvers.push(() =>
            resolve({ data: [{ slug: `${args.p_wine_id}-slug` }], error: null }),
          );
        });
      },
    };

    const donePromise = revalidateAutoEightysixedWines({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      restaurantId: "r-1",
      touchedWineIds: wineIds,
      sinceTs: "2026-01-01T00:00:00.000Z",
    });

    // Flush the microtask queue (events query resolving, then Promise.all
    // synchronously dispatching every rpc() call) without letting any of
    // the RPC promises resolve — they only resolve when we call the
    // captured resolvers below.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // All three RPC calls were issued up front. Sequential (await-in-loop)
    // code could only have reached the first one at this point, since
    // each rpc() promise here stays pending until manually resolved.
    expect(rpcCallCount).toBe(3);

    rpcResolvers.forEach((resolve) => resolve());
    await donePromise;

    expect(mockRevalidatePath).toHaveBeenCalledTimes(3);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/wine-a-slug");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/wine-b-slug");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/wine-c-slug");
  });

  it("keeps revalidating the other wines when one slug lookup errors", async () => {
    const wineIds = ["wine-a", "wine-b"];
    const supabase = {
      from: () => eventsChain(wineIds.map((id) => ({ wine_id: id }))),
      rpc: (_name: string, args: { p_wine_id: string }) => {
        if (args.p_wine_id === "wine-a") {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        return Promise.resolve({
          data: [{ slug: "wine-b-slug" }],
          error: null,
        });
      },
    };

    await revalidateAutoEightysixedWines({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      restaurantId: "r-1",
      touchedWineIds: wineIds,
      sinceTs: "2026-01-01T00:00:00.000Z",
    });

    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/wine-b-slug");
  });
});
