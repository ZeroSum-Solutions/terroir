import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { loadCellarGridSnapshot } from "./grid";

describe("cellar grid pagination", () => {
  it("does not skip the next row when an earlier row is deleted between pages", async () => {
    let liveRows = Array.from({ length: 1001 }, (_, index) => ({
      id: String(index + 1).padStart(4, "0"),
      bin_location: "A-1",
      quantity: 1,
      wines: {
        id: "wine-a",
        name: "Reserve",
        producer: "Domaine Test",
        vintage: 2020,
      },
    }));
    const cursors: Array<string | null> = [];
    let pageNumber = 0;

    const client = {
      from(table: string) {
        expect(table).toBe("inventory_items");
        let afterId: string | null = null;
        let pageLimit = 1000;
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          gt: (_column: string, value: string) => {
            afterId = value;
            return chain;
          },
          order: () => chain,
          limit: (value: number) => {
            pageLimit = value;
            return chain;
          },
          then: (
            resolve: (value: { data: typeof liveRows; error: null }) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => {
            cursors.push(afterId);
            const data = liveRows
              .filter((row) => afterId === null || row.id > afterId)
              .slice(0, pageLimit);
            pageNumber += 1;
            if (pageNumber === 1) {
              liveRows = liveRows.slice(1);
            }
            return Promise.resolve({ data, error: null }).then(
              resolve,
              reject,
            );
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient<Database>;

    const snapshot = await loadCellarGridSnapshot(client, "restaurant-a");

    expect(cursors).toEqual([null, "1000"]);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.grid["A-1"]).toMatchObject({
      totalBottles: 1001,
      wines: [{ wineId: "wine-a", quantity: 1001 }],
    });
  });
});
