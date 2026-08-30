import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { CellarWineRow } from "./types";
import { CellarRow } from "./cellar-row";

/**
 * BND-063 — DraggableWineRow. A wine row wrapped in useSortable for DnD.
 */
export function DraggableWineRow({
  row,
  sectionKey,
  lowStockThreshold,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
}: {
  row: CellarWineRow;
  sectionKey: string;
  lowStockThreshold?: number;
  onSelect: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.wine_id, data: { type: "wine", sectionKey } });

  // While dragging, the row keeps its space in the list but hands its
  // appearance to the portalled DragOverlay — a local z-index cannot escape
  // the section card's `overflow-hidden`.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "bg-wash rounded-lg")}
    >
      <CellarRow
        row={row}
        lowStockThreshold={lowStockThreshold}
        onSelect={onSelect}
        selectMode={selectMode}
        selected={selected}
        onToggleSelect={onToggleSelect}
        dragHandle={
          !selectMode
            ? { attributes: { ...attributes }, listeners: { ...listeners } }
            : undefined
        }
      />
    </div>
  );
}
