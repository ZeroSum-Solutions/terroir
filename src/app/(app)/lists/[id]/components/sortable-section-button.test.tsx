import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/sortable", () => ({
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

const { SortableSectionButton } = await import("./sortable-section-button");

function section() {
  return {
    id: "section-reds",
    name: "Reds",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: [
      {
        id: "item-1",
        section_id: "section-reds",
        wine_id: "wine-1",
        position: 0,
        glass_price: null,
        bottle_price: null,
        glass_pour_ml: null,
        pour_size_mode: "fixed" as const,
        tasting_note: null,
        name_override: null,
        blurb: null,
        hidden: false,
        wines: {
          id: "wine-1",
          name: "Estate Red",
          producer: "Demo Cellars",
          vintage: 2022,
          varietal: null,
          region: null,
        },
      },
    ],
  };
}

describe("SortableSectionButton", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  async function mount(props: Partial<React.ComponentProps<typeof SortableSectionButton>> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    const onEditStart = vi.fn();
    const onEditChange = vi.fn();
    const onEditCommit = vi.fn();
    const onEditCancel = vi.fn();
    await act(async () => {
      root.render(
        <SortableSectionButton
          section={section()}
          isActive={false}
          onSelect={onSelect}
          onDelete={onDelete}
          editingId={null}
          editName=""
          onEditStart={onEditStart}
          onEditChange={onEditChange}
          onEditCommit={onEditCommit}
          onEditCancel={onEditCancel}
          editRef={{ current: null }}
          canManage
          {...props}
        />,
      );
    });
    return { container, onSelect, onDelete, onEditStart, onEditChange, onEditCommit, onEditCancel };
  }

  it("shows the section name and wine count, and selects on click", async () => {
    const { container, onSelect } = await mount();

    const nameButton = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.includes("Reds"),
    )!;
    expect(nameButton.textContent).toContain("1");
    await act(async () => nameButton.click());
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("starts rename on the pencil action without triggering select", async () => {
    const { container, onEditStart, onSelect } = await mount();

    const renameButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Rename Reds"]',
    )!;
    await act(async () => renameButton.click());

    expect(onEditStart).toHaveBeenCalledWith("section-reds", "Reds");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("requests delete with the full section on the trash action", async () => {
    const { container, onDelete } = await mount();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete Reds"]',
    )!;
    await act(async () => deleteButton.click());

    expect(onDelete).toHaveBeenCalledWith(section());
  });

  it("swaps in the rename input and commits on Enter, cancels on Escape", async () => {
    const { container, onEditCommit, onEditCancel } = await mount({
      editingId: "section-reds",
      editName: "Cellar Reds",
    });

    const input = container.querySelector<HTMLInputElement>("input[type=text]")!;
    expect(input.value).toBe("Cellar Reds");

    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onEditCommit).toHaveBeenCalledOnce();

    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onEditCancel).toHaveBeenCalledOnce();
  });

  it("hides the rename/delete actions while editing", async () => {
    const { container } = await mount({ editingId: "section-reds", editName: "Reds" });

    expect(container.querySelector('[aria-label="Rename Reds"]')).toBeNull();
    expect(container.querySelector('[aria-label="Delete Reds"]')).toBeNull();
  });

  it("keeps the drag handle and action buttons at least 44px", async () => {
    const { container } = await mount();

    for (const selector of [
      '[aria-label="Drag to reorder Reds"]',
      '[aria-label="Rename Reds"]',
      '[aria-label="Delete Reds"]',
    ]) {
      const node = container.querySelector<HTMLElement>(selector)!;
      expect(node.className).toContain("min-h-11");
      expect(node.className).toContain("min-w-11");
    }
  });
});
