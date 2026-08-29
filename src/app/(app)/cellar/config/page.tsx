"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Pencil, Trash2, Check, X, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";

type Section = { id: string; name: string };

function generateId(): string {
  return crypto.randomUUID();
}

function arrayMove<T>(array: T[], from: number, to: number): T[] {
  const result = [...array];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

// Legacy cellar_config rows store `labels.sections` as plain name strings
// (still written by grid-label callers). Normalize those into the
// {id, name} shape this page edits, using the name itself as a stable id
// so re-fetches don't reshuffle React keys or drag order.
function normalizeSections(raw: unknown[]): Section[] {
  return raw.map((entry) =>
    typeof entry === "string"
      ? { id: entry, name: entry }
      : (entry as Section),
  );
}

export default function CellarConfigPage() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [sections, setSections] = useState<Section[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<Section | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap({
    containerRef: deleteDialogRef,
    onEscape: () => setDeleteTarget(null),
    enabled: deleteTarget !== null,
  });

  const [newName, setNewName] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const res = await fetch("/api/cellar/config");
        if (!res.ok) throw new Error("Failed to load config.");
        const config = await res.json();
        if (cancelled) return;
        if (config?.labels?.sections && Array.isArray(config.labels.sections)) {
          setSections(normalizeSections(config.labels.sections));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load.");
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (updated: Section[]) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/cellar/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sections: updated,
            section_order: updated.map((s) => s.id),
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(
            (payload as { error?: string })?.error ?? "Failed to save.",
          );
        }
        setSections(updated);
        startTransition(() => router.refresh());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const addSection = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    const updated = [...sections, { id: generateId(), name }];
    setNewName("");
    save(updated);
  }, [newName, sections, save]);

  const startEdit = useCallback((section: Section) => {
    setEditingId(section.id);
    setEditName(section.name);
  }, []);

  const commitEdit = useCallback(
    (id: string) => {
      const name = editName.trim();
      if (!name) {
        setEditingId(null);
        return;
      }
      const updated = sections.map((s) =>
        s.id === id ? { ...s, name } : s,
      );
      setEditingId(null);
      save(updated);
    },
    [editName, sections, save],
  );

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const updated = sections.filter((s) => s.id !== deleteTarget.id);
    setDeleteTarget(null);
    save(updated);
  }, [deleteTarget, sections, save]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sections.findIndex((s) => s.id === active.id);
      const newIndex = sections.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(sections, oldIndex, newIndex);
      setSections(reordered);
      save(reordered);
    },
    [sections, save],
  );

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[480px] px-md py-lg">
      <div className="mb-lg flex items-start gap-sm">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back to cellar"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface focus-ring"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} aria-hidden />
        </button>
        <div className="min-w-0 flex-1 pt-1.5">
          <h1 className="font-serif text-heading-sm md:text-heading font-normal text-ink">Cellar Sections</h1>
          <p className="text-[13px] text-grey">
            Organize your cellar into named groups like Reds by Region or Cult
            Cabs.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-md rounded-md border border-accent/30 bg-blush-wash px-md py-sm text-[13px] text-accent"
        >
          {error}
        </div>
      )}

      {sections.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sections.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="mb-lg divide-y divide-hairline rounded-card card-surface">
              {sections.map((section) => (
                <SortableSectionItem
                  key={section.id}
                  section={section}
                  editingId={editingId}
                  editName={editName}
                  busy={busy}
                  onStartEdit={startEdit}
                  onChangeEditName={setEditName}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                  onDelete={setDeleteTarget}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <p className="mb-lg rounded-card card-surface px-md py-lg text-center text-[14px] text-grey">
          No sections yet. Add your first one below.
        </p>
      )}

      <div className="flex gap-xs">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addSection();
          }}
          placeholder="New section name (e.g. Reds by Region)"
          className="min-w-0 flex-1 rounded-pill border border-hairline px-sm py-sm text-[14px] text-ink placeholder:text-grey focus-ring"
          disabled={busy}
        />
        <button
          type="button"
          onClick={addSection}
          disabled={busy || !newName.trim()}
          className={cn(
            "flex h-[44px] shrink-0 items-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-white transition-colors",
            "hover:bg-primary-hover disabled:opacity-60 focus-ring",
          )}
        >
          <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
          Add
        </button>
      </div>

      {deleteTarget && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; the dialog below has full keyboard access via useFocusTrap (Escape + a Cancel button).
        <div
          className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-scrim"
          onClick={() => setDeleteTarget(null)}
        >
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- onClick here only stops the backdrop's dismiss-click from bubbling; no independent interaction to reach by keyboard. */}
          <div
            ref={deleteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-section-heading"
            className="mx-md w-full max-w-[420px] rounded-card card-surface p-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="delete-section-heading"
              className="font-serif text-[18px] font-normal text-ink"
            >
              Delete section?
            </h3>
            <p className="mt-sm text-[14px] text-grey">
              This will permanently remove &ldquo;{deleteTarget.name}&rdquo;.
            </p>
            <div className="mt-lg flex gap-sm">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
                className="min-h-11 flex-1 rounded-pill border border-edge px-md py-sm text-[14px] font-medium text-ink hover:bg-bridge-surface disabled:opacity-60 focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="min-h-11 flex-1 rounded-pill bg-primary px-md py-sm text-[14px] font-medium text-white hover:bg-primary-hover disabled:opacity-60 focus-ring"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableSectionItem({
  section,
  editingId,
  editName,
  busy,
  onStartEdit,
  onChangeEditName,
  onCommitEdit,
  onCancelEdit,
  onDelete,
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
}) {
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
        isDragging && "touch-none bg-bridge-surface rounded-md",
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
            className="min-h-11 min-w-0 flex-1 rounded-pill border border-hairline px-sm py-sm text-[14px] text-ink focus-ring"
            autoFocus
          />
          <button
            type="button"
            onClick={() => onCommitEdit(section.id)}
            disabled={!editName.trim()}
            aria-label="Save rename"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-sage-ink hover:bg-sage-wash disabled:opacity-40 focus-ring"
          >
            <Check className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-label="Cancel rename"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface focus-ring"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-sm min-w-0">
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={`Drag to reorder ${section.name}`}
              className="flex h-11 w-11 shrink-0 touch-none items-center justify-center cursor-grab active:cursor-grabbing text-grey hover:text-ink focus-ring"
            >
              <GripVertical className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>

            <span className="min-w-0 flex-1 break-words text-[14px] font-medium text-ink">
              {section.name}
            </span>
          </div>
          <div className="flex items-center gap-xs shrink-0">
            <button
              type="button"
              onClick={() => onStartEdit(section)}
              disabled={busy}
              aria-label={`Rename ${section.name}`}
              className="flex h-11 w-11 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface disabled:opacity-40 focus-ring"
            >
              <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => onDelete(section)}
              disabled={busy}
              aria-label={`Delete ${section.name}`}
              className="flex h-11 w-11 items-center justify-center rounded-pill text-accent/70 hover:bg-blush-wash hover:text-accent disabled:opacity-40 focus-ring"
            >
              <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </>
      )}
    </li>
  );
}
