"use client";

import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";

type Wine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  drink_window_start?: number | null;
  drink_window_end?: number | null;
  serving_temp_min?: number | null;
  serving_temp_max?: number | null;
  serving_temp_label?: string | null;
};

type Item = {
  id: string;
  section_id: string;
  wine_id: string;
  position: number;
  glass_price: number | null;
  bottle_price: number | null;
  glass_pour_ml: number | null;
  pour_size_mode: "fixed" | "picker";
  tasting_note: string | null;
  name_override: string | null;
  blurb: string | null;
  hidden: boolean;
  wines: Wine;
};

type Section = {
  id: string;
  name: string;
  position: number;
  wine_list_id: string;
  wine_list_items: Item[];
};

// BND-161: inline-rename input overlay.
// BND-162: sortable section sidebar button.
export function SortableSectionButton({
  section,
  isActive,
  onSelect,
  onDelete,
  editingId,
  editName,
  onEditStart,
  onEditChange,
  onEditCommit,
  onEditCancel,
  editRef,
}: {
  section: Section;
  isActive: boolean;
  onSelect: () => void;
  onDelete: (section: Section) => void;
  editingId: string | null;
  editName: string;
  onEditStart: (id: string, name: string) => void;
  onEditChange: (name: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  editRef: React.RefObject<HTMLInputElement | null>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: section.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const isEditing = editingId === section.id;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center rounded-pill transition-colors",
        isActive && !isDragging
          ? "bg-wash"
          : "hover:bg-wash",
      )}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex min-h-11 min-w-11 flex-shrink-0 cursor-grab touch-none items-center justify-center px-1 py-xs text-grey hover:text-ink active:cursor-grabbing"
        aria-label={`Drag to reorder ${section.name}`}
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      {/* Section name or inline edit input */}
      {isEditing ? (
        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-xs px-sm py-xs">
          <input
            ref={editRef}
            type="text"
            value={editName}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditCommit();
              if (e.key === "Escape") onEditCancel();
            }}
            onBlur={onEditCommit}
            className="min-h-11 min-w-0 flex-1 rounded-pill border border-accent bg-surface px-sm py-0.5 text-[13px] font-medium text-ink outline-none focus-ring"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex min-h-11 min-w-0 flex-1 items-center justify-between px-sm py-xs text-left focus-ring",
            isActive ? "text-ink font-medium" : "text-grey",
          )}
        >
          {/* BUG-03. `truncate` on a single line left ~50px for the name once
              the drag handle and the two 44px action buttons had taken their
              132px of a 248px sidebar — about seven characters, which rendered
              "Sparkl…", "Desse…", and, worst of all, TWO sections both reading
              "Reds - …". A sidebar whose only job is to name sections was not
              naming them. The column is now 288px and the name wraps to two
              lines rather than clipping, which is what actually buys the
              characters: shrinking the controls would have put them back under
              the 44px touch floor. */}
          <span
            className="line-clamp-2 min-w-0 break-words text-[14px]"
            title={section.name}
          >
            {section.name}
          </span>
          <span
            className={cn(
              "tabular text-[12px] ml-xs shrink-0",
              isActive ? "text-ink" : "text-grey",
            )}
          >
            {section.wine_list_items.length}
          </span>
        </button>
      )}

      {/* BUG-03 — these stay in flow on purpose. Hiding them behind
          `opacity-0` and overlaying the row reclaims width for the name, but an
          opacity-0 button still takes taps: on an iPad, which meets the `md`
          breakpoint with no hover, tapping the right of a row would hit an
          invisible Rename or Delete instead of selecting the section. The room
          for the name comes from the sidebar's own width instead. */}
      {!isEditing && (
        <div className="flex items-center gap-0.5 pr-sm">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditStart(section.id, section.name);
            }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-pill text-grey hover:bg-surface-sunken hover:text-ink"
            aria-label={`Rename ${section.name}`}
          >
            <Pencil className="h-3 w-3" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(section);
            }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-pill text-grey hover:bg-risk-wash hover:text-risk-ink"
            aria-label={`Delete ${section.name}`}
          >
            <Trash2 className="h-3 w-3" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
