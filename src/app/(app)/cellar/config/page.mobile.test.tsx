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
