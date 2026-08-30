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

// BND-162: sensors + reorder handler for the section sidebar drag-and-drop.
export function useSectionReorder(
  sections: WineListEditorSection[],
  setSections: React.Dispatch<React.SetStateAction<WineListEditorSection[]>>,
  setErrorToast: React.Dispatch<React.SetStateAction<string | null>>,
) {
  const sectionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleSectionDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sections.findIndex((s) => s.id === active.id);
      const newIndex = sections.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Save previous order for rollback
      const previous = sections.map((s) => ({ ...s }));

      const reordered = [...sections];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      // Optimistic update
      setSections(reordered.map((s, i) => ({ ...s, position: i })));

      // Persist
      const res = await fetch("/api/wine-list-sections/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: reordered.map((s) => s.id) }),
      });

      // Rollback on failure
      if (!res.ok) {
        setSections(previous.map((s, i) => ({ ...s, position: i })));
        setErrorToast("Failed to reorder sections. Please try again.");
        setTimeout(() => setErrorToast(null), 4000);
      }
    },
    [sections],
  );

  return { sectionSensors, handleSectionDragEnd };
}
