import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { WineListEditorSection } from "./wine-list-editor";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  fetch: vi.fn(),
  dndIds: [] as Array<string | undefined>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, id }: { children: ReactNode; id?: string }) => {
    mocks.dndIds.push(id);
    return children;
  },
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

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
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

function section(
  overrides: Partial<WineListEditorSection> = {},
): WineListEditorSection {
  return {
    id: "section-reds",
    name: "Reds",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: [],
    ...overrides,
  };
}

function completeListFixture(): React.ComponentProps<
  typeof WineListEditor
>["list"] {
  return {
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
  };
}

function editorProps(
  overrides: Partial<React.ComponentProps<typeof WineListEditor>> = {},
): React.ComponentProps<typeof WineListEditor> {
  return {
    list: completeListFixture(),
    sections: [section()],
    brandKit: null,
    canManageBranding: true,
    ...overrides,
  };
}

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      node.textContent?.trim() === name || node.getAttribute("aria-label") === name,
  )!;
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dndIds.length = 0;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  vi.stubGlobal(
    "fetch",
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 })),
  );
});

it("uses a stable drag-and-drop identifier during server rendering", () => {
  renderToStaticMarkup(<WineListEditor {...editorProps()} />);

  expect(mocks.dndIds).toContain("wine-list-sections-dnd");
  expect(mocks.dndIds).not.toContain(undefined);
});

it("keeps the list-editor navigation and wine actions phone-sized", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <WineListEditor {...editorProps()} />,
  );

  const controls = [
    document.querySelector<HTMLAnchorElement>('a[href="/lists"]'),
    [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Add wine",
    ),
    [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Add another wine"),
    ),
  ];
  for (const control of controls) {
    expect(control).not.toBeNull();
    expect(control?.className).toContain("min-h-11");
  }
});

it("keeps desktop list actions touch-sized for phone landscape", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <WineListEditor {...editorProps()} />,
  );
  const desktopActions = document.querySelector(
    'header [aria-label="List actions"]',
  )!;

  desktopActions.querySelectorAll("button,a").forEach((control) => {
    expect(control.className).toContain("min-h-11");
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  Reflect.deleteProperty(window, "prompt");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps every header action labelled in the mobile-only rail", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <WineListEditor {...editorProps()} />,
  );
  const mobile = document.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;

  expect(mobile.className).toContain("md:hidden");
  for (const name of [
    "Download PDF",
    "Toast Export",
    "CSV",
    "Preview",
    "Print",
    "Publish",
  ]) {
    const action = [...mobile.querySelectorAll<HTMLElement>("button,a")].find(
      (node) => node.textContent?.trim() === name,
    )!;
    expect(action.className).toContain("min-h-11");
  }
});

it("shows section add, rename, delete, and template actions in the mobile-only controls", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <WineListEditor {...editorProps({ sections: [section()] })} />,
  );
  const mobile = document.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;

  expect(mobile.className).toContain("md:hidden");
  for (const label of ["Add section", "Rename Reds", "Delete Reds"]) {
    const control =
      mobile.querySelector<HTMLElement>(`[aria-label="${label}"]`) ??
      [...mobile.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.trim() === label,
      )!;
    expect(control.className).toContain("min-h-11");
  }
  expect(mobile.textContent).toContain("Template");
});

it.each([
  ["Enter", "PATCH"],
  ["Escape", null],
] as const)("handles %s from the visible mobile rename input", async (key, method) => {
  const { container } = await mount(
    <WineListEditor {...editorProps({ sections: [section()] })} />,
  );
  const mobile = container.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;

  await act(async () => button(mobile, "Rename Reds").click());
  const input = mobile.querySelector<HTMLInputElement>(
    'input[aria-label="Section name"]',
  )!;
  expect(input).not.toBeNull();
  await change(input, "Cellar Reds");
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );

  if (method) {
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method }),
    );
  } else {
    expect(mocks.fetch).not.toHaveBeenCalled();
  }
});

it("commits the visible mobile rename once on blur", async () => {
  const { container } = await mount(
    <WineListEditor {...editorProps({ sections: [section()] })} />,
  );
  const mobile = container.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;

  await act(async () => button(mobile, "Rename Reds").click());
  const input = mobile.querySelector<HTMLInputElement>(
    'input[aria-label="Section name"]',
  )!;
  await change(input, "Cellar Reds");
  await act(async () => {
    input.focus();
    input.blur();
  });

  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("does not commit twice when Enter is followed by blur", async () => {
  const { container } = await mount(
    <WineListEditor {...editorProps({ sections: [section()] })} />,
  );
  const mobile = container.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;
  await act(async () => button(mobile, "Rename Reds").click());
  const input = mobile.querySelector<HTMLInputElement>(
    'input[aria-label="Section name"]',
  )!;
  await change(input, "Cellar Reds");

  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.blur();
  });

  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("does not commit when Escape is followed by blur", async () => {
  const { container } = await mount(
    <WineListEditor {...editorProps({ sections: [section()] })} />,
  );
  const mobile = container.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;
  await act(async () => button(mobile, "Rename Reds").click());
  const input = mobile.querySelector<HTMLInputElement>(
    'input[aria-label="Section name"]',
  )!;
  await change(input, "Cellar Reds");

  await act(async () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.blur();
  });

  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("deletes only the section selected in the mobile controls", async () => {
  const first = section({ id: "section-reds", name: "Reds", position: 0 });
  const second = section({ id: "section-whites", name: "Whites", position: 1 });
  const { container } = await mount(
    <WineListEditor {...editorProps({ sections: [first, second] })} />,
  );
  const mobile = container.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;

  const select = mobile.querySelector<HTMLSelectElement>("#mobile-section")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      select,
      second.id,
    );
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(select.value).toBe(second.id);
  await act(async () => button(mobile, "Delete Whites").click());
  expect(mocks.fetch).not.toHaveBeenCalled();
  await act(async () =>
    button(container.querySelector('[role="dialog"]')!, "Delete section").click(),
  );

  expect(mocks.fetch).toHaveBeenCalledWith(
    "/api/wine-list-sections/section-whites",
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(mocks.fetch).not.toHaveBeenCalledWith(
    "/api/wine-list-sections/section-reds",
    expect.anything(),
  );
});

it("offers recovery when the list has no sections", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <WineListEditor {...editorProps({ sections: [] })} />,
  );

  expect(document.querySelector("h2")?.textContent).toBe("Start your list");
  const recovery = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === "Add first section",
  )!;
  expect(recovery.disabled).toBe(false);
  expect(recovery.className).toContain("min-h-11");
});

it("recovers a zero-section list locally after adding its first section", async () => {
  Object.defineProperty(window, "prompt", {
    configurable: true,
    value: vi.fn(() => "Sparkling"),
  });
  mocks.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        id: "section-sparkling",
        wine_list_id: "list-1",
        name: "Sparkling",
        position: 0,
        created_at: "2026-08-21T00:00:00.000Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    ),
  );
  const { container } = await mount(
    <WineListEditor {...editorProps({ sections: [] })} />,
  );
  const mobile = container.querySelector<HTMLElement>(
    '[data-testid="mobile-list-controls"]',
  )!;

  await act(async () => {
    button(mobile, "Add first section").click();
    await Promise.resolve();
  });

  const select = mobile.querySelector<HTMLSelectElement>("#mobile-section")!;
  expect(select).not.toBeNull();
  expect(select.value).toBe("section-sparkling");
  expect(select.selectedOptions[0]?.textContent).toBe("Sparkling (0)");
  expect(button(mobile, "Rename Sparkling")).toBeDefined();
  expect(button(mobile, "Delete Sparkling")).toBeDefined();
  expect(mocks.fetch).toHaveBeenCalledWith(
    "/api/wine-list-sections",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ wine_list_id: "list-1", name: "Sparkling" }),
    }),
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
