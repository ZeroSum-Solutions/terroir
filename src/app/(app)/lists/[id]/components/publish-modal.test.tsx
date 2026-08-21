import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("qrcode", () => ({
  toString: vi.fn().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" />'),
  toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test"),
}));

const { PublishModal } = await import("./publish-modal");

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

describe("PublishModal unpublish confirmation", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("cancels without a request and confirms the captured list exactly once", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const { container } = await mount(
      <PublishModal
        listId="list-42"
        listName="Dinner List"
        currentSlug="dinner-list"
        isPublished
        onClose={onClose}
      />,
    );

    await click(button(container, "Unpublish"));
    expect(fetchMock).not.toHaveBeenCalled();
    let dialog = dialogByTitle(container, "Unpublish list");
    expect(dialog).toBeDefined();
    expect(dialog!.textContent).toContain("Dinner List");
    await click(button(dialog!, "Cancel"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dialogByTitle(container, "Unpublish list")).toBeUndefined();

    await click(button(container, "Unpublish"));
    dialog = dialogByTitle(container, "Unpublish list")!;
    await click(button(dialog, "Unpublish list"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/wine-lists/list-42/publish", {
      method: "DELETE",
    });

    dialog = dialogByTitle(container, "Unpublish list")!;
    expect(button(dialog, "Unpublish list").disabled).toBe(true);
    await click(button(dialog, "Cancel"));
    pressEscape();
    await mouseDown(container.querySelector<HTMLElement>('[data-action-dialog-backdrop="true"]')!);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dialogByTitle(container, "Unpublish list")).toBeDefined();

    await act(async () => {
      pending.resolve(okResponse());
      await pending.promise;
    });
    expect(dialogByTitle(container, "Unpublish list")).toBeUndefined();
    expect(container.textContent).toContain("Publish wine list");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retains the failed unpublish target, reports the error, and retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Public link is locked." }, 409))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await mount(
      <PublishModal
        listId="list-fail"
        listName="Reserve List"
        currentSlug="reserve"
        isPublished
        onClose={vi.fn()}
      />,
    );

    await click(button(container, "Unpublish"));
    await click(button(dialogByTitle(container, "Unpublish list")!, "Unpublish list"));
    expect(dialogByTitle(container, "Unpublish list")).toBeDefined();
    expect(dialogByTitle(container, "Unpublish list")!.querySelector('[role="alert"]')?.textContent).toContain(
      "Public link is locked.",
    );

    await click(button(dialogByTitle(container, "Unpublish list")!, "Unpublish list"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dialogByTitle(container, "Unpublish list")).toBeUndefined();
  });

  it.each([
    { isPublished: false, currentSlug: null },
    { isPublished: true, currentSlug: "dinner-list" },
  ])("keeps the $isPublished publish state scrollable and touch sized", async ({ isPublished, currentSlug }) => {
    const { container } = await mount(
      <PublishModal
        listId="list-touch"
        listName="Dinner List"
        currentSlug={currentSlug}
        isPublished={isPublished}
        onClose={vi.fn()}
      />,
    );

    const panel = container.querySelector<HTMLElement>("[data-publish-panel]");
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(panel?.className).toContain("overflow-y-auto");

    const controls = container.querySelectorAll<HTMLElement>(
      'input, button, a[href]',
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(
        control.className.includes("h-11") ||
          control.className.includes("min-h-11"),
        control.textContent?.trim() || control.id,
      ).toBe(true);
    }
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
