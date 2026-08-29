import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }),
}));

const { default: CellarConfigPage } = await import("./page");

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
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Manage Cellar Sections mobile layout", () => {
  it("does not size its content column off the broken max-w-{lg,sm} keyword scale", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const column = container.querySelector<HTMLElement>("div.mx-auto")!;
    expect(column.className).not.toContain("max-w-lg");
    expect(column.className).not.toMatch(/\bmax-w-sm\b/);
    expect(column.className).toContain("max-w-[480px]");
  });

  it("gives every row action a 44px touch target", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const dragHandle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Drag to reorder Reds"]',
    )!;
    const rename = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Reds"]',
    )!;
    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Reds"]',
    )!;
    const back = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to cellar"]',
    )!;

    for (const button of [dragHandle, rename, del]) {
      expect(button.className).toContain("h-11");
      expect(button.className).toContain("w-11");
      // The page previously relied on a non-existent `touch:` Tailwind
      // variant that silently compiled to nothing.
      expect(button.className).not.toContain("touch:");
    }
    expect(back.className).toContain("h-11");
    expect(back.className).toContain("w-11");
    expect(back.className).toContain("shrink-0");
  });

  it("keeps the back button from being squeezed by the title/description text", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const textColumn = container.querySelector("h1")!.parentElement!;
    expect(textColumn.className).toContain("min-w-0");
  });

  it("normalizes legacy plain-string sections into named, uniquely-keyed rows", async () => {
    // cellar_config.labels.sections is still written elsewhere as a plain
    // string array (pre BND-060/062 shape). Confirm the page renders real
    // names instead of blank rows with colliding `undefined` React keys.
    stubConfigFetch(["Sparkling", "Whites", "Rose"]);
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const names = [...container.querySelectorAll("li span")].map((s) => s.textContent);
    expect(names).toEqual(["Sparkling", "Whites", "Rose"]);
    expect(
      container.querySelector('button[aria-label="Rename Sparkling"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Delete Whites"]'),
    ).not.toBeNull();
  });

  it("separates the delete confirmation from ordinary edits and keeps its actions touch sized", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Reds"]',
    )!;
    await act(async () => del.click());

    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    const [cancelButton, deleteButton] = [
      ...dialog.querySelectorAll<HTMLButtonElement>("button"),
    ];
    expect(cancelButton.textContent).toBe("Cancel");
    expect(deleteButton.textContent).toBe("Delete");
    expect(cancelButton.className).toContain("min-h-11");
    expect(deleteButton.className).toContain("min-h-11");
  });

  it("traps focus inside the delete dialog and closes it on Escape, returning focus to the trigger", async () => {
    // Regression coverage for wiring useFocusTrap into the delete dialog:
    // without the trap, Escape does nothing (dialog stays mounted) and the
    // trigger button never regains focus.
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Reds"]',
    )!;
    del.focus();
    await act(async () => del.click());
    await flushFocusFrame();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const cancelButton = dialog!.querySelector<HTMLButtonElement>("button")!;
    expect(cancelButton.textContent).toBe("Cancel");
    // The trap auto-focuses the dialog's first control on open.
    expect(document.activeElement).toBe(cancelButton);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // The trap restores focus to whatever triggered it (the Delete button).
    expect(document.activeElement).toBe(del);
  });

  it("gives the row-level delete button a distinct rest-state color from rename, not just adjacency", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const rename = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Reds"]',
    )!;
    const del = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Reds"]',
    )!;

    // Touch devices never see :hover, so the two icon buttons must already
    // read differently at rest — not just on a hover state that mobile
    // never triggers.
    expect(rename.className).toContain("text-grey");
    expect(del.className).not.toContain("text-grey");
    expect(del.className).toMatch(/text-accent/);

    // And they need real breathing room between them, not a 2px seam.
    const actionsRow = rename.parentElement!;
    expect(actionsRow.className).not.toContain("gap-2xs");
    expect(actionsRow.className).toContain("gap-xs");
  });

  it("wraps long section names instead of truncating them mid-word", async () => {
    stubConfigFetch({
      id: "a",
      name: "A Very Long Section Name For Testing Wrap Behavior",
    });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const nameSpan = container.querySelector("li span")!;
    expect(nameSpan.className).not.toContain("truncate");
    expect(nameSpan.className).toContain("break-words");
    expect(nameSpan.textContent).toBe(
      "A Very Long Section Name For Testing Wrap Behavior",
    );
  });

  it("gives the inline rename input a real touch target instead of a 32px sliver", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const rename = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Reds"]',
    )!;
    await act(async () => rename.click());

    const input = container.querySelector<HTMLInputElement>(
      'li input[type="text"]',
    )!;
    expect(input.className).toContain("min-h-11");
    // The old `py-1` sizing produced a ~32px input beside 44px Save/Cancel
    // buttons; py-1 must not sneak back in.
    expect(input.className).not.toMatch(/\bpy-1\b/);
  });

  it("lets the entire inline rename row shrink inside a 320px list item", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const rename = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Reds"]',
    )!;
    await act(async () => rename.click());

    const input = container.querySelector<HTMLInputElement>(
      'li input[type="text"]',
    )!;
    const renameRow = input.parentElement!;
    expect(renameRow.className).toContain("min-w-0");
  });

  it("lets the new-section input shrink instead of pushing Add off-screen", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder^="New section name"]',
    )!;
    const addButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Add",
    )!;

    // Without min-w-0, the input's intrinsic content width refuses to
    // shrink in a flex row, pushing Add past the 320px viewport edge.
    expect(input.className).toContain("min-w-0");
    expect(addButton.className).toContain("shrink-0");
  });

  it("uses the outline focus-visible pattern, not ring utilities, on every input", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const newSectionInput = container.querySelector<HTMLInputElement>(
      'input[placeholder^="New section name"]',
    )!;
    expect(newSectionInput.className).toContain("focus-ring");
    expect(newSectionInput.className).not.toMatch(/focus(-visible)?:(ring|outline)/);

    const rename = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Rename Reds"]',
    )!;
    await act(async () => rename.click());
    const renameInput = container.querySelector<HTMLInputElement>(
      'li input[type="text"]',
    )!;
    expect(renameInput.className).toContain("focus-ring");
    expect(renameInput.className).not.toMatch(/focus(-visible)?:(ring|outline)/);
  });

  it("shows the burgundy outline immediately on the Add button", async () => {
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const addButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add",
    )!;
    expect(addButton.className).toContain("focus-ring");
    expect(addButton.className).not.toMatch(/focus(-visible)?:(ring|outline)/);
  });

  it("disables native touch-scroll handling on the drag handle so dnd-kit's TouchSensor can activate", async () => {
    // Without touch-action: none, the browser's own pan-to-scroll gesture
    // wins the race on the first touchmove and fires pointercancel before
    // dnd-kit's TouchSensor (delay: 200ms) ever activates — reorder is
    // silently non-functional under real touch even though mouse drags work.
    stubConfigFetch({ id: "a", name: "Reds" });
    const { container } = await mount(<CellarConfigPage />);
    await flushLoad();

    const dragHandle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Drag to reorder Reds"]',
    )!;
    expect(dragHandle.className).toContain("touch-none");
  });
});

function stubConfigFetch(sections: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({
        id: "config-1",
        rows: 10,
        columns: 10,
        name: "Main Cellar",
        labels: { sections: Array.isArray(sections) ? sections : [sections] },
      }),
    ),
  );
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

async function flushLoad() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushFocusFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}
