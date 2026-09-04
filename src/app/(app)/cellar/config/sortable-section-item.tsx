"use client";

import { useId } from "react";
import { Check, GripVertical, Pencil, Trash2, X } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { CellarSection as Section } from "../sections";

export function SortableSectionItem({
  section,
  editingId,
  editName,
  busy,
  onStartEdit,
  onChangeEditName,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onKeyboardMove,
}: {
  section: Section;
  editingId: string | null;
  editName: string;
  busy: boolean;
  onStartEdit: (s: Section) => void;
  onChangeEditName: (v: string) => void;
  onCommitEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDelete: (s: Section) => void;
  onKeyboardMove: (id: string, direction: -1 | 1) => void;
}) {
  const reorderHelpId = useId();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: section.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center justify-between px-md py-sm",
        isDragging && "touch-none bg-wash rounded-md",
      )}
    >
      {editingId === section.id ? (
        <div className="flex min-w-0 flex-1 items-center gap-xs">
          <input
            type="text"
            value={editName}
            onChange={(e) => onChangeEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitEdit(section.id);
              if (e.key === "Escape") onCancelEdit();
            }}
            className="min-h-11 min-w-0 flex-1 rounded-pill border border-rule px-sm py-sm text-control text-ink focus-ring"
            autoFocus
          />
          <button
            type="button"
            onClick={() => onCommitEdit(section.id)}
            disabled={!editName.trim()}
            aria-label="Save rename"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-ready-ink hover:bg-ready-wash disabled:opacity-40 focus-ring"
          >
            <Check className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-label="Cancel rename"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-wash focus-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-sm min-w-0">
            <p id={reorderHelpId} className="sr-only">
              Use the Up and Down arrow keys to move this section.
            </p>
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${section.name}`}
              aria-describedby={reorderHelpId}
              aria-keyshortcuts="ArrowUp ArrowDown"
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                onKeyboardMove(section.id, event.key === "ArrowUp" ? -1 : 1);
              }}
              className="flex h-11 w-11 shrink-0 touch-none items-center justify-center cursor-grab active:cursor-grabbing text-grey hover:text-ink focus-ring"
            >
              <GripVertical className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>

            <span className="min-w-0 flex-1 break-words text-control font-medium text-ink">
              {section.name}
            </span>
          </div>
          <div className="flex items-center gap-xs shrink-0">
            <button
              type="button"
              onClick={() => onStartEdit(section)}
              disabled={busy}
              aria-label={`Rename ${section.name}`}
              className="flex h-11 w-11 items-center justify-center rounded-pill text-grey hover:bg-wash disabled:opacity-40 focus-ring"
            >
              <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => onDelete(section)}
              disabled={busy}
              aria-label={`Delete ${section.name}`}
              className="flex h-11 w-11 items-center justify-center rounded-pill text-risk-ink/70 hover:bg-risk-wash hover:text-risk-ink disabled:opacity-40 focus-ring"
            >
              <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </>
      )}
    </li>
  );
}
