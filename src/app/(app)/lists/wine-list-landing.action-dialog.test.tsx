import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WineListWithCount } from "@/lib/wine-list/types";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
}));

const { WineListLanding } = await import("./wine-list-landing");

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
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
});

describe("WineListLanding permanent-delete confirmation", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    refresh.mockClear();
    push.mockClear();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("keeps every card action at least 44px tall on mobile", async () => {
    const list = wineList({
      id: "published-list",
      name: "Published list",
      archived: false,
      is_published: true,
      slug: "published-list",
    });
    const { container } = await mount(
      <WineListLanding lists={[list]} archivedLists={[]} />,
    );

    for (const label of [
      "Copy public link for Published list",
      "Open public Published list list in a new tab",
      "Clone Published list",
      "Archive Published list",
    ]) {
      const control = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      expect(control.className, label).toContain("min-h-11");
    }
    expect(
      container.querySelector<HTMLElement>('[aria-label="Archive Published list"]')
        ?.className,
    ).toContain("min-w-11");
  });

  it.each([
    [
      true,
      'Permanently delete "Published archive"? This list is currently published — its public link will stop working immediately. This cannot be undone.',
    ],
    [
      false,
      'Permanently delete "Draft archive"? Its sections and items will be removed. This cannot be undone.',
    ],
  ])("preserves the archived-list warning when published is %s", async (published, warning) => {
    const list = wineList({
      id: published ? "published-list" : "draft-list",
      name: published ? "Published archive" : "Draft archive",
      archived: true,
      is_published: published,
    });
    const { container } = await mount(
      <WineListLanding lists={[]} archivedLists={[list]} showArchived />,
    );

    await click(buttonByLabel(container, `Permanently delete ${list.name}`));
    const dialog = dialogByTitle(container, "Permanently delete list");
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toContain(warning);
  });

  it("cancels without a request, blocks duplicate/close while busy, and clears after success", async () => {
    const list = wineList({ id: "list-42", name: "Reserve", archived: true });
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mount(
      <WineListLanding lists={[]} archivedLists={[list]} showArchived />,
    );

    await click(buttonByLabel(container, "Permanently delete Reserve"));
    await click(button(dialogByTitle(container, "Permanently delete list")!, "Cancel"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "Permanently delete list")).toBeUndefined();

    await click(buttonByLabel(container, "Permanently delete Reserve"));
    let dialog = dialogByTitle(container, "Permanently delete list")!;
    await click(button(dialog, "Permanently delete list"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/wine-lists/list-42", { method: "DELETE" });

    dialog = dialogByTitle(container, "Permanently delete list")!;
    expect(button(dialog, "Permanently delete list").disabled).toBe(true);
    await click(button(dialog, "Cancel"));
    pressEscape();
    await mouseDown(container.querySelector<HTMLElement>('[data-action-dialog-backdrop="true"]')!);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dialogByTitle(container, "Permanently delete list")).toBeDefined();

    await act(async () => {
      pending.resolve(okResponse());
      await pending.promise;
    });
    expect(dialogByTitle(container, "Permanently delete list")).toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the failed target and existing error available for retry", async () => {
    const list = wineList({ id: "list-fail", name: "Cellar Picks", archived: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "List is still referenced." }, 409))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mount(
      <WineListLanding lists={[]} archivedLists={[list]} showArchived />,
    );

    await click(buttonByLabel(container, "Permanently delete Cellar Picks"));
    await click(button(dialogByTitle(container, "Permanently delete list")!, "Permanently delete list"));
    expect(dialogByTitle(container, "Permanently delete list")).toBeDefined();
    expect(dialogByTitle(container, "Permanently delete list")!.querySelector('[role="alert"]')?.textContent).toContain(
      "List is still referenced.",
    );

    await click(button(dialogByTitle(container, "Permanently delete list")!, "Permanently delete list"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dialogByTitle(container, "Permanently delete list")).toBeUndefined();
  });

  it("never offers permanent deletion for a non-archived list", async () => {
    const list = wineList({ id: "active-list", name: "Active list", archived: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mount(<WineListLanding lists={[list]} />);

    expect(buttonByLabelOrNull(container, "Permanently delete Active list")).toBeNull();
    expect(dialogByTitle(container, "Permanently delete list")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps archive and clone on their existing native-confirm workflows", async () => {
    const list = wineList({ id: "active-list", name: "Active list", archived: false });
    const confirm = vi.mocked(window.confirm);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mount(<WineListLanding lists={[list]} />);

    await click(buttonByLabel(container, "Archive Active list"));
    await click(buttonByLabel(container, "Clone Active list"));

    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Archive "Active list"? It will be hidden from the default view but can be restored later.',
    );
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Clone "Active list"? A new unpublished copy will be created with all sections and items preserved.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "Permanently delete list")).toBeUndefined();
  });

  async function mount(element: ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(element));
    return { container, root };
  }
});

function wineList(overrides: Partial<WineListWithCount>): WineListWithCount {
  return {
    id: "list-1",
    restaurant_id: "restaurant-1",
    name: "Wine list",
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
    wine_count: 3,
    ...overrides,
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

function buttonByLabelOrNull(root: ParentNode, label: string) {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
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

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
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
