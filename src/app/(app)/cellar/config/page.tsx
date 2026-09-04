"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus } from "lucide-react";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { normalizeSections, type CellarSection as Section } from "../sections";
import { SortableSectionItem } from "./sortable-section-item";

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

  const moveSectionWithKeyboard = useCallback(
    (id: string, direction: -1 | 1) => {
      const oldIndex = sections.findIndex((section) => section.id === id);
      const newIndex = oldIndex + direction;
      if (oldIndex === -1 || newIndex < 0 || newIndex >= sections.length) return;

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
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-wash focus-ring"
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
          className="mb-md rounded-md border border-risk-ink/30 bg-risk-wash px-md py-sm text-[13px] text-risk-ink"
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
            <ul className="mb-lg divide-y divide-rule rounded-card card-surface">
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
                  onKeyboardMove={moveSectionWithKeyboard}
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
          className="min-w-0 flex-1 rounded-pill border border-rule px-sm py-sm text-[14px] text-ink placeholder:text-grey focus-ring"
          disabled={busy}
        />
        <button
          type="button"
          onClick={addSection}
          disabled={busy || !newName.trim()}
          className={cn(
            "flex h-[44px] shrink-0 items-center gap-xs rounded-pill bg-primary px-md text-[14px] font-medium text-seal-ink transition-colors",
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
                className="min-h-11 flex-1 rounded-pill border border-edge px-md py-sm text-[14px] font-medium text-ink hover:bg-wash disabled:opacity-60 focus-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="min-h-11 flex-1 rounded-pill bg-primary px-md py-sm text-[14px] font-medium text-seal-ink hover:bg-primary-hover disabled:opacity-60 focus-ring"
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
