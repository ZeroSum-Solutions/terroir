import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import type { WineListEditorItem, WineListEditorSection } from "./wine-list-editor";
import { useWineItemReorder } from "./use-wine-item-reorder";

function item(overrides: Partial<WineListEditorItem> = {}): WineListEditorItem {
  return {
    id: "item-1",
    section_id: "section-reds",
    wine_id: "wine-1",
    position: 0,
    glass_price: null,
    bottle_price: null,
    glass_pour_ml: null,
    pour_size_mode: "fixed",
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
    ...overrides,
  };
}

function section(items: WineListEditorItem[]): WineListEditorSection {
  return {
    id: "section-reds",
    name: "Reds",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: items,
  };
}

function dragEvent(activeId: string, overId: string): DragEndEvent {
  return {
    active: { id: activeId },
    over: { id: overId },
  } as unknown as DragEndEvent;
}

function Harness({
  initialSections,
  onSectionsChange,
}: {
  initialSections: WineListEditorSection[];
  onSectionsChange: (sections: WineListEditorSection[]) => void;
}) {
  const [sections, setSections] = useState(initialSections);
  const [activeSection] = useState(initialSections[0]?.id ?? "");
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const currentSection = sections.find((s) => s.id === activeSection);
  const { handleDragEnd } = useWineItemReorder(
    currentSection,
    activeSection,
    setSections,
    setErrorToast,
  );

  onSectionsChange(sections);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void handleDragEnd(dragEvent("item-1", "item-2"));
        }}
      >
        Reorder
      </button>
      {errorToast && <p role="alert">{errorToast}</p>}
    </div>
  );
}

describe("useWineItemReorder", () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function mount(initialSections: WineListEditorSection[]) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    let latest = initialSections;
    await act(async () => {
      root.render(
        <Harness
          initialSections={initialSections}
          onSectionsChange={(sections) => {
            latest = sections;
          }}
        />,
      );
    });
    return { container, getSections: () => latest };
  }

  it("optimistically reorders items within the active section and persists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const initial = [
      section([
        item({ id: "item-1", position: 0 }),
        item({ id: "item-2", position: 1 }),
      ]),
    ];
    const { container, getSections } = await mount(initial);

    await act(async () => {
      container.querySelector("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSections()[0].wine_list_items.map((i) => i.id)).toEqual([
      "item-2",
      "item-1",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/wine-list-items/reorder",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ orderedIds: ["item-2", "item-1"] }),
      }),
    );
  });

  it("rolls back item order and surfaces an error toast on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const initial = [
      section([
        item({ id: "item-1", position: 0 }),
        item({ id: "item-2", position: 1 }),
      ]),
    ];
    const { container, getSections } = await mount(initial);

    await act(async () => {
      container.querySelector("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSections()[0].wine_list_items.map((i) => i.id)).toEqual([
      "item-1",
      "item-2",
    ]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Failed to reorder wines. Please try again.",
    );
  });
});
