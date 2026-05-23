"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
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

  const [newName, setNewName] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cellar/config");
      if (!res.ok) throw new Error("Failed to load config.");
      const config = await res.json();
      if (config?.labels?.sections && Array.isArray(config.labels.sections)) {
        setSections(config.labels.sections);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    <div className="mx-auto max-w-lg px-md py-lg">
      <div className="mb-lg flex items-center gap-sm">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back to cellar"
          className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
        >
          <ArrowLeft className="h-5 w-5" strokeWidth={2} aria-hidden />
        </button>
        <div>
          <h1 className="text-[18px] font-semibold text-ink">Cellar Sections</h1>
          <p className="text-[13px] text-ink-muted">
            Organize your cellar into named groups like Reds by Region or Cult
            Cabs.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-md rounded-sm border border-danger/30 bg-danger-soft px-md py-sm text-[13px] text-danger"
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
            <ul className="mb-lg divide-y divide-border rounded-md border border-border bg-white">
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
        <p className="mb-lg rounded-md border border-border bg-surface-muted px-md py-lg text-center text-[14px] text-ink-muted">
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
          className="flex-1 rounded-sm border border-border px-sm py-sm text-[14px] text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent-soft"
          disabled={busy}
        />
        <button
          type="button"
          onClick={addSection}
          disabled={busy || !newName.trim()}
          className={cn(
            "flex h-[44px] items-center gap-xs rounded-sm bg-accent px-md text-[14px] font-medium text-white transition-colors",
            "hover:bg-accent-hover disabled:opacity-60",
          )}
        >
          <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
          Add
        </button>
      </div>

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-section-heading"
            className="mx-md w-full max-w-sm rounded-md bg-white p-lg shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="delete-section-heading"
              className="text-[16px] font-semibold text-ink"
            >
              Delete section?
            </h3>
            <p className="mt-sm text-[14px] text-ink-muted">
              This will permanently remove &ldquo;{deleteTarget.name}&rdquo;.
            </p>
            <div className="mt-lg flex gap-sm">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
                className="flex-1 rounded-sm border border-border px-md py-sm text-[14px] font-medium text-ink hover:bg-surface-muted disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="flex-1 rounded-sm bg-danger px-md py-sm text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-60"
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
        isDragging && "bg-surface-muted shadow-md rounded-md",
      )}
    >
      {editingId === section.id ? (
        <div className="flex flex-1 items-center gap-xs">
          <input
            type="text"
            value={editName}
            onChange={(e) => onChangeEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitEdit(section.id);
              if (e.key === "Escape") onCancelEdit();
            }}
            className="flex-1 rounded-sm border border-border px-xs py-1 text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-soft"
            autoFocus
          />
          <button
            type="button"
            onClick={() => onCommitEdit(section.id)}
            disabled={!editName.trim()}
            aria-label="Save rename"
            className="flex h-8 w-8 items-center justify-center rounded-sm text-success hover:bg-success-soft disabled:opacity-40"
          >
            <Check className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-label="Cancel rename"
            className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted"
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
              className="flex h-8 w-6 shrink-0 items-center justify-center cursor-grab active:cursor-grabbing text-ink-subtle hover:text-ink-muted touch:min-h-[44px] touch:min-w-[44px]"
            >
              <GripVertical className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>

            <span className="text-[14px] font-medium text-ink truncate">
              {section.name}
            </span>
          </div>
          <div className="flex items-center gap-2xs shrink-0">
            <button
              type="button"
              onClick={() => onStartEdit(section)}
              disabled={busy}
              aria-label={`Rename ${section.name}`}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted disabled:opacity-40"
            >
              <Pencil className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => onDelete(section)}
              disabled={busy}
              aria-label={`Delete ${section.name}`}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-ink-muted hover:bg-danger-soft hover:text-danger disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </>
      )}
    </li>
  );
}
