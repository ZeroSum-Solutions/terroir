import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WineList } from "@/lib/wine-list/types";
import type {
  WineListEditorItem,
  WineListEditorSection,
} from "./wine-list-editor";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { WineListEditor } = await import("./wine-list-editor");

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

describe("WineListEditor section-delete confirmation", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    refresh.mockClear();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("cancels without deleting and sends the captured section once after confirmation", async () => {
    const target = section({ id: "section-42", name: "Reserve Reds" });
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountEditor([target]);

    await click(buttonByLabel(container, "Delete Reserve Reds"));
    let dialog = dialogByTitle(container, "Delete section");
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toContain("Reserve Reds");
    await click(button(dialog!, "Cancel"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "Delete section")).toBeUndefined();

    await click(buttonByLabel(container, "Delete Reserve Reds"));
    dialog = dialogByTitle(container, "Delete section")!;
    await click(button(dialog, "Delete section"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/wine-list-sections/section-42", {
      method: "DELETE",
    });

    dialog = dialogByTitle(container, "Delete section")!;
    expect(button(dialog, "Delete section").disabled).toBe(true);
    await click(button(dialog, "Cancel"));
    pressEscape();
    await mouseDown(container.querySelector<HTMLElement>('[data-action-dialog-backdrop="true"]')!);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dialogByTitle(container, "Delete section")).toBeDefined();

    await act(async () => {
      pending.resolve(okResponse());
      await pending.promise;
    });
    expect(dialogByTitle(container, "Delete section")).toBeUndefined();
  });

  it("keeps the failed section target and existing error state for retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("failure", { status: 500 }))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountEditor([
      section({ id: "section-fail", name: "Library", wine_list_items: [wineItem()] }),
    ]);

    await click(buttonByLabel(container, "Delete Library"));
    await click(button(dialogByTitle(container, "Delete section")!, "Delete section"));
    expect(dialogByTitle(container, "Delete section")).toBeDefined();
    expect(dialogByTitle(container, "Delete section")!.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't delete section. Please try again.",
    );

    await click(button(dialogByTitle(container, "Delete section")!, "Delete section"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dialogByTitle(container, "Delete section")).toBeUndefined();
  });

  it("leaves wine-item removal on its existing dedicated workflow", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mountEditor([
      section({ name: "Reds", wine_list_items: [wineItem()] }),
    ]);

    await click(buttonByLabel(container, "Remove Pinot Noir"));
    const heading = [...container.querySelectorAll("h3")].find(
      (node) => node.textContent === "Remove wine",
    );
    expect(heading).toBeDefined();
    expect(dialogByTitle(container, "Remove wine")).toBeUndefined();
    await click(button(heading!.parentElement!.parentElement!, "Cancel"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  async function mountEditor(sections: WineListEditorSection[]) {
    return mount(
      <WineListEditor
        list={wineList()}
        sections={sections}
        brandKit={null}
        canManage
      />,
    );
  }

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

function wineList(): Omit<WineList, "wine_list_sections"> {
  return {
    id: "list-1",
    restaurant_id: "restaurant-1",
    name: "Dinner List",
    description: null,
    slug: null,
    template: "classic",
    theme: null,
    show_bin_codes: false,
    archived: false,
    is_published: false,
    last_published_at: null,
    created_at: "2026-08-20T12:00:00.000Z",
    updated_at: "2026-08-20T12:00:00.000Z",
  };
}

function section(overrides: Partial<WineListEditorSection> = {}): WineListEditorSection {
  return {
    id: "section-1",
    name: "Reds",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: [],
    ...overrides,
  };
}

function wineItem(): WineListEditorItem {
  return {
    id: "item-1",
    section_id: "section-1",
    wine_id: "wine-1",
    position: 0,
    glass_price: 15,
    bottle_price: 60,
    glass_pour_ml: 148,
    pour_size_mode: "fixed",
    tasting_note: null,
    name_override: null,
    blurb: null,
    hidden: false,
    wines: {
      id: "wine-1",
      name: "Pinot Noir",
      producer: "Test Producer",
      vintage: 2023,
      varietal: "Pinot Noir",
      region: "Willamette Valley",
    },
  };
}

function dialogByTitle(root: ParentNode, title: string) {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (dialog) => dialog.querySelector("h2")?.textContent === title,
  );
}

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  )!;
}

function buttonByLabel(root: ParentNode, label: string) {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function mouseDown(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function okResponse() {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
