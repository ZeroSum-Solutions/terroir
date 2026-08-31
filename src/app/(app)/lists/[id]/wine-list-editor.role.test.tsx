/**
 * SD-12 — `/lists/[id]` is membership-only, but every write the editor makes
 * is `requireRole(["owner", "manager"])`: sections (create, rename, delete,
 * reorder), items (create, patch, delete, reorder) and the list itself
 * (template, publish). Staff were handed the whole armed editor and learned
 * none of it worked from the 403s that came back — compounded by SD-18, which
 * made those 403s silent.
 *
 * The server side is correct and unchanged. These lock the affordance to the
 * permission and keep the read-only half — the wines, their prices, and the
 * export/preview/print row — exactly as it was.
 */
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WineListEditorItem,
  WineListEditorSection,
} from "./wine-list-editor.types";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), fetch: vi.fn() }));

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

/** Every control on the editor whose route answers 403 to a staff member. */
const MUTATION_LABELS = [
  "Increase glass price for Barolo",
  "Decrease glass price for Barolo",
  "Edit glass price for Barolo",
  "Increase bottle price for Barolo",
  "Decrease bottle price for Barolo",
  "Edit bottle price for Barolo",
  "Pour size in ml for Barolo",
  "Rename Barolo",
  "Remove Barolo",
  "Rename Red",
  "Delete Red",
  "Drag to reorder",
  "Drag to reorder Red",
];

const MUTATION_TEXT = ["Add section", "Add wine", "Add another wine", "Template"];

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
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("WineListEditor role affordance", () => {
  it("gives a manager the whole editor", async () => {
    const container = await mount(true);
    for (const label of MUTATION_LABELS) {
      expect(labelled(container, label), label).not.toBeNull();
    }
    for (const text of MUTATION_TEXT) {
      expect(container.textContent, text).toContain(text);
    }
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("offers a staff member no control the API would refuse", async () => {
    const container = await mount(false);
    for (const label of MUTATION_LABELS) {
      expect(labelled(container, label), label).toBeNull();
    }
    for (const text of MUTATION_TEXT) {
      expect(container.textContent, text).not.toContain(text);
    }
    // The blurb textarea and the hidden/visible toggle are writes too.
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Visible");
    expect(container.textContent).not.toContain("Hidden");
  });

  it("keeps the read-only half of the editor intact for staff", async () => {
    const container = await mount(false);
    expect(container.textContent).toContain("Dinner");
    expect(container.textContent).toContain("Red");
    expect(container.textContent).toContain("Giacomo Conterno, Barolo");
    // Prices are still legible, just not editable.
    expect(container.textContent).toContain("$24");
    expect(container.textContent).toContain("$180");
    // Exports and preview need no role and stay.
    expect(container.textContent).toContain("Download PDF");
    expect(container.textContent).toContain("Preview");
    expect(container.textContent).toContain("Print");
  });
});

function labelled(container: HTMLElement, label: string): Element | null {
  return container.querySelector(`[aria-label="${label}"]`);
}

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

async function mount(canManage: boolean): Promise<HTMLElement> {
  return render(
    <WineListEditor
      list={{
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
      }}
      sections={[section()]}
      brandKit={null}
      canManage={canManage}
    />,
  );
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}
