/**
 * SD-18 — every wine-list-item write failed silently.
 *
 * Price, pour, display name, blurb and hidden all wrote optimistically and
 * then, on a non-ok response, did nothing but `router.refresh()`. The row
 * snapped back to its old value with no explanation — and because every one of
 * those routes is `requireRole(["owner", "manager"])`, a staff member's 403
 * read as "the app forgot what I typed". Deleting a wine had the same shape.
 *
 * These mount the real editor and drive a real control, so what is under test
 * is what the operator would see.
 */
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WineListEditorItem,
  WineListEditorSection,
} from "./wine-list-editor.types";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  closestCenter: vi.fn(),
  PointerSensor: class {},
  TouchSensor: class {},
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn((...sensors) => sensors),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

const { WineListEditor } = await import("./wine-list-editor");

const roots: Root[] = [];
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("wine-list item write failures", () => {
  it("reports a refused price change instead of silently reverting", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Managers only." } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const container = await mount();
    await click(container, "Increase glass price for Barolo");

    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/wine-list-items/item-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(container.textContent).toContain("Managers only.");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("falls back to a plain message when the response carries none", async () => {
    mocks.fetch.mockResolvedValue(new Response("", { status: 500 }));

    const container = await mount();
    await click(container, "Increase bottle price for Barolo");

    expect(container.textContent).toContain("Couldn't save the bottle price");
  });

  it("reports a network failure rather than swallowing the rejection", async () => {
    mocks.fetch.mockRejectedValue(new Error("Network down"));

    const container = await mount();
    await click(container, "Increase glass price for Barolo");

    expect(container.textContent).toContain("Network down");
  });

  it("says nothing when the write succeeds", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const container = await mount();
    await click(container, "Increase glass price for Barolo");

    expect(container.textContent).not.toContain("Couldn't save");
  });
});

function item(): WineListEditorItem {
  return {
    id: "item-1",
    section_id: "section-red",
    wine_id: "wine-red",
    position: 0,
    glass_price: 24,
    bottle_price: 180,
    glass_pour_ml: 148,
    pour_size_mode: "fixed",
    tasting_note: null,
    name_override: null,
    blurb: null,
    hidden: false,
    suggested_glass_price: null,
    suggested_bottle_price: null,
    wines: {
      id: "wine-red",
      name: "Barolo",
      producer: "Giacomo Conterno",
      vintage: 2016,
      varietal: "Nebbiolo",
      region: "Piedmont",
      colour: "red",
      hero_image_url: null,
    },
  };
}

function section(): WineListEditorSection {
  return {
    id: "section-red",
    name: "Red",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: [item()],
  };
}

function editorProps(): React.ComponentProps<typeof WineListEditor> {
  return {
    list: {
      archived: false,
      created_at: "2026-08-20T00:00:00.000Z",
      description: null,
      id: "list-1",
      is_published: false,
      last_published_at: null,
      name: "Dinner",
      restaurant_id: "restaurant-1",
      show_bin_codes: false,
      slug: null,
      template: "classic",
      theme: null,
      updated_at: "2026-08-20T00:00:00.000Z",
    },
    sections: [section()],
    brandKit: null,
    canManage: true,
  };
}

async function mount(): Promise<HTMLElement> {
  return render(<WineListEditor {...editorProps()} />);
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`No control labelled "${label}"`);
  await act(async () => {
    button.click();
  });
}
