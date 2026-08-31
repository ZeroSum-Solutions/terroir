/**
 * LIST-06 — "wines added to a wine list don't register".
 *
 * These mount the real editor and drive `onAdd` through a stubbed modal, so
 * what is under test is the editor's own state handling — the thing that was
 * broken. `useState(initialSections)` ignores refreshed props, so before this
 * fix the row was written to the database and never appeared on screen.
 */
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AddWineRequest } from "./use-add-wine";
import type { WineListEditorSection } from "./wine-list-editor.types";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  fetch: vi.fn(),
  onAdd: null as ((request: AddWineRequest) => void) | null,
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

/**
 * A stand-in for the add-wine modal. The modal's own search/suggestion
 * plumbing is covered by its own suite; here it only has to hand the editor
 * the request a completed add produces.
 */
vi.mock("./components/add-wine-modal", () => ({
  AddWineModal: ({ onAdd }: { onAdd: (request: AddWineRequest) => void }) => {
    mocks.onAdd = onAdd;
    return null;
  },
}));

const { WineListEditor } = await import("./wine-list-editor");

const WINE = {
  id: "wine-red",
  name: "Vosne-Romanée",
  producer: "Benjamin Leroux",
  vintage: 2019,
  varietal: "Pinot Noir",
  region: "Burgundy",
  colour: "red",
  hero_image_url: null,
};

function addRequest(overrides: Partial<AddWineRequest> = {}): AddWineRequest {
  return {
    wine: WINE,
    glassPrice: 24,
    bottlePrice: 180,
    suggestedGlassPrice: 22,
    suggestedBottlePrice: 175,
    sectionIds: ["section-red"],
    ...overrides,
  };
}

function section(id: string, name: string): WineListEditorSection {
  return {
    id,
    name,
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: [],
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
    sections: [section("section-sparkling", "Sparkling"), section("section-red", "Red")],
    brandKit: null,
    canManageBranding: false,
  };
}

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
  mocks.onAdd = null;
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

/** Opens the modal stub and runs one add through it. */
async function completeAdd(container: HTMLElement, request: AddWineRequest) {
  const open = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Add wine",
  )!;
  await act(async () => open.click());
  expect(mocks.onAdd).not.toBeNull();
  await act(async () => {
    await mocks.onAdd!(request);
  });
}

function created(id: string) {
  return new Response(JSON.stringify({ id }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

it("shows the added wine immediately, with no reload", async () => {
  mocks.fetch.mockResolvedValueOnce(created("item-1"));
  const container = await mount(<WineListEditor {...editorProps()} />);

  expect(container.textContent).not.toContain("Vosne-Romanée");
  await completeAdd(container, addRequest());

  expect(mocks.fetch).toHaveBeenCalledWith(
    "/api/wine-list-items",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        section_id: "section-red",
        wine_id: "wine-red",
        glass_price: 24,
        bottle_price: 180,
      }),
    }),
  );
  expect(container.textContent).toContain("Vosne-Romanée");
  expect(
    container.querySelector('[aria-label="Remove Vosne-Romanée"]'),
  ).not.toBeNull();
});

it("moves to the section the wine was actually filed into", async () => {
  mocks.fetch.mockResolvedValueOnce(created("item-1"));
  const container = await mount(<WineListEditor {...editorProps()} />);

  // The user is looking at Sparkling; the wine is a red.
  const openSection = () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("Add another wine to"))
      ?.textContent?.replace("Add another wine to ", "");
  expect(openSection()).toBe("Sparkling");

  await completeAdd(container, addRequest());

  expect(openSection()).toBe("Red");
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Added Benjamin Leroux, Vosne-Romanée to Red.",
  );
});

it("surfaces a failed add instead of doing nothing visible", async () => {
  mocks.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { message: "nope" } }), { status: 500 }),
  );
  const container = await mount(<WineListEditor {...editorProps()} />);

  await completeAdd(container, addRequest());

  expect(container.textContent).toContain(
    "Couldn't add Benjamin Leroux, Vosne-Romanée to Red. Please try again.",
  );
  // The row itself is absent — only the error names the wine.
  expect(
    container.querySelector('[aria-label="Remove Vosne-Romanée"]'),
  ).toBeNull();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("reports what landed when one section of a multi-section add fails", async () => {
  mocks.fetch
    .mockResolvedValueOnce(created("item-1"))
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  const container = await mount(<WineListEditor {...editorProps()} />);

  await completeAdd(
    container,
    addRequest({ sectionIds: ["section-red", "section-sparkling"] }),
  );

  expect(container.textContent).toContain(
    "Added Benjamin Leroux, Vosne-Romanée to Red, but Sparkling failed.",
  );
  // The half that landed is on screen, not implied away.
  expect(container.textContent).toContain("Vosne-Romanée");
});

it("shows the suggested price on the new row rather than a dash", async () => {
  mocks.fetch.mockResolvedValueOnce(created("item-1"));
  const container = await mount(<WineListEditor {...editorProps()} />);

  await completeAdd(
    container,
    addRequest({ glassPrice: null, bottlePrice: null }),
  );

  const bottle = container.querySelector<HTMLButtonElement>(
    '[aria-label="Edit bottle price for Vosne-Romanée"]',
  )!;
  expect(bottle.textContent).toBe("$175");
  expect(container.textContent).toContain("Suggested");
});
