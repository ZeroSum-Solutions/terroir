import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WineListWithCount } from "@/lib/wine-list/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { WineListLanding } = await import("./wine-list-landing");

/**
 * SD-12 — `/lists` is membership-only, but every write behind it is
 * `requireRole(["owner", "manager"])`: POST /api/wine-lists (create),
 * PATCH /api/wine-lists/{id} (rename/archive/restore), DELETE
 * /api/wine-lists/{id}, POST /api/wine-lists/{id}/clone. A staff member saw
 * New wine list, Clone, Archive and Delete, and learned none of them worked
 * only from the 403 that came back.
 *
 * The server side is correct and unchanged. These lock the affordance to the
 * permission — and keep the read-only half (Copy link, Open the public list,
 * Show archived) exactly as it was, because those need no role.
 */
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
const roots: Root[] = [];

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("WineListLanding role affordance", () => {
  it("offers a manager every list action", async () => {
    const container = await mount(
      <WineListLanding
        lists={[published()]}
        archivedLists={[archived()]}
        showArchived
        canManage
      />,
    );

    expect(labels(container)).toEqual(
      expect.arrayContaining([
        "Copy public link for House List",
        "Open public House List list in a new tab",
        // GLOBAL-01: Clone, Archive/Restore and Delete are behind the card's
        // one overflow trigger — five controls did not fit a 390px card footer
        // (e2e/one-row-rule.test.ts). The trigger is what a manager sees; the
        // verbs are inside it.
        "More actions for House List",
        "More actions for Retired List",
      ]),
    );
    expect(await menuItems(container, "House List")).toEqual(["Clone", "Archive"]);
    expect(await menuItems(container, "Retired List")).toEqual([
      "Clone",
      "Restore",
      "Permanently delete",
    ]);
    expect(container.textContent).toContain("New wine list");
    expect(container.textContent).toContain("Create a new list");
  });

  it("offers a staff member no control the API would refuse", async () => {
    const container = await mount(
      <WineListLanding
        lists={[published()]}
        archivedLists={[archived()]}
        showArchived
        canManage={false}
      />,
    );

    // An OverflowMenu with no items renders nothing at all, so a staff member
    // gets no trigger either — not a trigger that opens onto an empty menu.
    for (const label of [
      "More actions for House List",
      "More actions for Retired List",
    ]) {
      expect(labelled(container, label), label).toBeNull();
    }
    expect(container.textContent).not.toContain("Clone");
    expect(container.textContent).not.toContain("Permanently delete");
    expect(container.textContent).not.toContain("New wine list");
    expect(container.textContent).not.toContain("Create a new list");

    // Reading the lists needs no role, and neither does the public link.
    expect(container.textContent).toContain("House List");
    expect(container.textContent).toContain("Retired List");
    expect(labelled(container, "Copy public link for House List")).not.toBeNull();
    expect(
      labelled(container, "Open public House List list in a new tab"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Hide archived");
  });

  it("does not invite a staff member to create the first list", async () => {
    const container = await mount(
      <WineListLanding lists={[]} archivedLists={[]} canManage={false} />,
    );
    expect(container.textContent).not.toContain("New wine list");
    expect(container.textContent).not.toContain("Create your first wine list");
    expect(container.querySelector("button")).toBeNull();
  });
});

function published(): WineListWithCount {
  return list({
    id: "list-published",
    name: "House List",
    archived: false,
    is_published: true,
    slug: "house-list",
  });
}

function archived(): WineListWithCount {
  return list({ id: "list-archived", name: "Retired List", archived: true });
}

function list(overrides: Partial<WineListWithCount>): WineListWithCount {
  return {
    id: "list-1",
    restaurant_id: "restaurant-1",
    name: "List",
    description: null,
    slug: null,
    is_published: false,
    archived: false,
    theme: null,
    last_published_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    wine_count: 3,
    ...overrides,
  } as WineListWithCount;
}

function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[aria-label]")].map(
    (node) => node.getAttribute("aria-label") ?? "",
  );
}

function labelled(container: HTMLElement, label: string): Element | null {
  return container.querySelector(`[aria-label="${label}"]`);
}

/** Opens one card's overflow menu and reads back the verbs it offers. */
async function menuItems(container: HTMLElement, listName: string): Promise<string[]> {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="More actions for ${listName}"]`,
  );
  if (!trigger) return [];
  await act(async () => trigger.click());
  const menu = container.querySelector<HTMLElement>(
    `[role="menu"][aria-label="More actions for ${listName}"]`,
  );
  const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map(
    (node) => node.textContent?.trim() ?? "",
  );
  await act(async () => trigger.click());
  return items;
}

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}
