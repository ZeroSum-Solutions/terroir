import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import type { WineListEditorSection } from "./wine-list-editor";
import { useSectionReorder } from "./use-section-reorder";

function section(overrides: Partial<WineListEditorSection> = {}): WineListEditorSection {
  return {
    id: "section-reds",
    name: "Reds",
    position: 0,
    wine_list_id: "list-1",
    wine_list_items: [],
    ...overrides,
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
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const { handleSectionDragEnd } = useSectionReorder(sections, setSections, setErrorToast);

  onSectionsChange(sections);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void handleSectionDragEnd(dragEvent("section-reds", "section-whites"));
        }}
      >
        Reorder
      </button>
      {errorToast && <p role="alert">{errorToast}</p>}
    </div>
  );
}

describe("useSectionReorder", () => {
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
    let latest: WineListEditorSection[] = initialSections;
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

  it("optimistically reorders and persists the new order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const initial = [
      section({ id: "section-reds", name: "Reds", position: 0 }),
      section({ id: "section-whites", name: "Whites", position: 1 }),
    ];
    const { container, getSections } = await mount(initial);

    await act(async () => {
      container.querySelector("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSections().map((s) => s.id)).toEqual(["section-whites", "section-reds"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/wine-list-sections/reorder",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ orderedIds: ["section-whites", "section-reds"] }),
      }),
    );
  });

  it("rolls back the order and surfaces an error toast on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const initial = [
      section({ id: "section-reds", name: "Reds", position: 0 }),
      section({ id: "section-whites", name: "Whites", position: 1 }),
    ];
    const { container, getSections } = await mount(initial);

    await act(async () => {
      container.querySelector("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getSections().map((s) => s.id)).toEqual(["section-reds", "section-whites"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Failed to reorder sections. Please try again.",
    );
  });

  it("no-ops when dropped on itself or outside a droppable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const initial = [section()];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    let latest = initial;
    await act(async () => {
      root.render(
        <SameDropHarness
          initialSections={initial}
          onSectionsChange={(sections) => {
            latest = sections;
          }}
        />,
      );
    });

    await act(async () => container.querySelector("button")!.click());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest).toEqual(initial);
  });
});

function SameDropHarness({
  initialSections,
  onSectionsChange,
}: {
  initialSections: WineListEditorSection[];
  onSectionsChange: (sections: WineListEditorSection[]) => void;
}) {
  const [sections, setSections] = useState(initialSections);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const { handleSectionDragEnd } = useSectionReorder(sections, setSections, setErrorToast);

  onSectionsChange(sections);

  return (
    <button
      type="button"
      onClick={() => {
        void handleSectionDragEnd(dragEvent("section-reds", "section-reds"));
      }}
    >
      Drop
    </button>
  );
}
