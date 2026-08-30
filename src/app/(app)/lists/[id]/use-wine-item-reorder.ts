"use client";

import { useCallback } from "react";
import {
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { WineListEditorSection } from "./wine-list-editor";

// Wine-item drag sensors + reorder handler (within a section).
export function useWineItemReorder(
  currentSection: WineListEditorSection | undefined,
  activeSection: string,
  setSections: React.Dispatch<React.SetStateAction<WineListEditorSection[]>>,
  setErrorToast: React.Dispatch<React.SetStateAction<string | null>>,
) {
  const wineSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !currentSection) return;

      const items = [...currentSection.wine_list_items];
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Save previous items order for rollback
      const previousItems = currentSection.wine_list_items.map((i) => ({ ...i }));

      const [moved] = items.splice(oldIndex, 1);
      items.splice(newIndex, 0, moved);

      setSections((prev) =>
        prev.map((s) =>
          s.id === activeSection
            ? { ...s, wine_list_items: items.map((it, idx) => ({ ...it, position: idx })) }
            : s,
        ),
      );

      const res = await fetch("/api/wine-list-items/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: items.map((i) => i.id) }),
      });

      // Rollback on failure
      if (!res.ok) {
        setSections((prev) =>
          prev.map((s) =>
            s.id === activeSection
              ? { ...s, wine_list_items: previousItems.map((it, idx) => ({ ...it, position: idx })) }
              : s,
          ),
        );
        setErrorToast("Failed to reorder wines. Please try again.");
        setTimeout(() => setErrorToast(null), 4000);
      }
    },
    [currentSection, activeSection],
  );

  return { wineSensors, handleDragEnd };
}
