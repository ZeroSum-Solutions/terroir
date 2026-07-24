import { describe, expect, it, vi } from "vitest";
import {
  areAllOwnWineListItems,
  isOwnWineListItem,
  isOwnWineListSection,
} from "./wine-list-scope";

function singleClient(result: { data: unknown; error: unknown }) {
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve(result),
        }),
      }),
    })),
  } as never;
}

function listClient(result: { data: unknown; error: unknown }) {
  return {
    from: vi.fn(() => ({
      select: () => ({
        in: () => Promise.resolve(result),
      }),
    })),
  } as never;
}

describe("wine-list tenant scope helpers", () => {
  it("throws item lookup provider failures", async () => {
    const providerError = { code: "XX000", message: "provider unavailable" };

    await expect(
      isOwnWineListItem(singleClient({ data: null, error: providerError }), "i1", "r1"),
    ).rejects.toBe(providerError);
  });

  it("keeps missing and foreign items opaque", async () => {
    await expect(
      isOwnWineListItem(
        singleClient({
          data: null,
          error: { code: "PGRST116", message: "no rows" },
        }),
        "i1",
        "r1",
      ),
    ).resolves.toBe(false);

    await expect(
      isOwnWineListItem(
        singleClient({
          data: {
            wine_list_sections: {
              wine_lists: { restaurant_id: "r2" },
            },
          },
          error: null,
        }),
        "i1",
        "r1",
      ),
    ).resolves.toBe(false);
  });

  it("throws section lookup provider failures", async () => {
    const providerError = { code: "XX000", message: "provider unavailable" };

    await expect(
      isOwnWineListSection(
        singleClient({ data: null, error: providerError }),
        "s1",
        "r1",
      ),
    ).rejects.toBe(providerError);
  });

  it("requires every requested item to belong to the active tenant", async () => {
    await expect(
      areAllOwnWineListItems(
        listClient({
          data: [
            {
              id: "i1",
              wine_list_sections: {
                wine_lists: { restaurant_id: "r1" },
              },
            },
          ],
          error: null,
        }),
        ["i1", "i2"],
        "r1",
      ),
    ).resolves.toBe(false);
  });

  it("throws batch lookup provider failures", async () => {
    const providerError = { code: "XX000", message: "provider unavailable" };

    await expect(
      areAllOwnWineListItems(
        listClient({ data: null, error: providerError }),
        ["i1"],
        "r1",
      ),
    ).rejects.toBe(providerError);
  });
});
