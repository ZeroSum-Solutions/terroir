"use client";

import { useCallback, useMemo, useState, useTransition, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Printer,
  Share2,
  Trash2,
  X,
} from "lucide-react";
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
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "@/lib/api/idempotency-client";
import type { WineList } from "@/lib/wine-list/types";
import { type Template } from "@/lib/wine-list/types";
import { SortableWineRow } from "./components/wine-row";
import { AddWineModal } from "./components/add-wine-modal";
import { PublishModal } from "./components/publish-modal";
import { TemplatePicker } from "./components/template-picker";

export type WineListEditorWine = {
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

export type WineListEditorItem = {
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
  wines: WineListEditorWine;
};

export type WineListEditorSection = {
  id: string;
  name: string;
  position: number;
  wine_list_id: string;
  wine_list_items: WineListEditorItem[];
};

function isOkMutation(data: unknown): data is { ok: true } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { ok?: unknown }).ok === true
  );
}

function createdItemId(data: unknown): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return (data as { id: string }).id;
}

function createdSectionId(data: unknown): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return (data as { id: string }).id;
}

function commandIdentity(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function restoreWineSectionOrderAfterFailedReorder(
  currentSections: WineListEditorSection[],
  previousSections: WineListEditorSection[],
): WineListEditorSection[] {
  const previousRank = new Map(
    previousSections.map((section, index) => [section.id, index]),
  );
  const currentRank = new Map(
    currentSections.map((section, index) => [section.id, index]),
  );

  return [...currentSections]
    .sort((left, right) => {
      const leftPreviousRank = previousRank.get(left.id);
      const rightPreviousRank = previousRank.get(right.id);
      if (leftPreviousRank === undefined && rightPreviousRank === undefined) {
        return currentRank.get(left.id)! - currentRank.get(right.id)!;
      }
      if (leftPreviousRank === undefined) return 1;
      if (rightPreviousRank === undefined) return -1;
      return leftPreviousRank - rightPreviousRank;
    })
    .map((section, position) => ({ ...section, position }));
}

export function restoreWineItemOrderAfterFailedReorder(
  currentItems: WineListEditorItem[],
  previousItems: WineListEditorItem[],
): WineListEditorItem[] {
  const previousRank = new Map(
    previousItems.map((item, index) => [item.id, index]),
  );
  const currentRank = new Map(
    currentItems.map((item, index) => [item.id, index]),
  );

  return [...currentItems]
    .sort((left, right) => {
      const leftPreviousRank = previousRank.get(left.id);
      const rightPreviousRank = previousRank.get(right.id);
      if (leftPreviousRank === undefined && rightPreviousRank === undefined) {
        return currentRank.get(left.id)! - currentRank.get(right.id)!;
      }
      if (leftPreviousRank === undefined) return 1;
      if (rightPreviousRank === undefined) return -1;
      return leftPreviousRank - rightPreviousRank;
    })
    .map((item, position) => ({ ...item, position }));
}

// BND-161: inline-rename input overlay.
// BND-162: sortable section sidebar button.
function SortableSectionButton({
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
  section: WineListEditorSection;
  isActive: boolean;
  onSelect: () => void;
  onDelete: (section: WineListEditorSection) => void;
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
        "group flex items-center rounded-sm transition-colors",
        isActive && !isDragging
          ? "bg-surface-muted shadow-sm"
          : "hover:bg-surface-muted",
      )}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex-shrink-0 cursor-grab touch-none px-1 py-xs text-ink-subtle hover:text-ink active:cursor-grabbing"
        aria-label={`Drag to reorder ${section.name}`}
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      {/* Section name or inline edit input */}
      {isEditing ? (
        <div className="flex-1 flex items-center gap-xs min-w-0 px-sm py-xs">
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
            className="flex-1 min-w-0 rounded-sm border border-accent bg-white px-xs py-0.5 text-[13px] font-medium text-ink outline-none focus:ring-2 focus:ring-accent-soft"
            autoFocus
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex-1 flex items-center justify-between min-w-0 px-sm py-xs text-left",
            isActive ? "text-ink font-medium" : "text-ink-muted",
          )}
        >
          <span className="truncate text-[14px]">{section.name}</span>
          <span
            className={cn(
              "tabular text-[12px] ml-xs",
              isActive ? "text-ink" : "text-ink-subtle",
            )}
          >
            {section.wine_list_items.length}
          </span>
        </button>
      )}

      {/* Action buttons — visible on hover */}
      {!isEditing && (
        <div className="hidden group-hover:flex items-center gap-0.5 pr-sm">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEditStart(section.id, section.name);
            }}
            className="p-1 rounded-sm text-ink-subtle hover:text-ink hover:bg-surface-sunken"
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
            className="p-1 rounded-sm text-ink-subtle hover:text-danger hover:bg-danger-soft"
            aria-label={`Delete ${section.name}`}
          >
            <Trash2 className="h-3 w-3" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}

export function WineListEditor({
  list,
  sections: initialSections,
}: {
  list: Omit<WineList, "wine_list_sections">;
  sections: WineListEditorSection[];
}) {
  const router = useRouter();
  const [wineListCommands] = useState(() =>
    createIdempotentCommandStore({
      persistence: createSessionCommandPersistence(
        "terroir:wine-list-editor",
      ),
    }),
  );
  const [sections, setSections] = useState(initialSections);
  const [activeSection, setActiveSection] = useState(
    initialSections[0]?.id ?? "",
  );
  const [isPending, startTransition] = useTransition();

  // BND-161: inline rename state
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editSectionName, setEditSectionName] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input when entering edit mode
  useEffect(() => {
    if (editingSectionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSectionId]);

  // BND-163: delete confirmation state
  const [deleteTarget, setDeleteTarget] =
    useState<WineListEditorSection | null>(null);

  // BND-194: delete wine item confirmation state
  const [wineToDelete, setWineToDelete] =
    useState<WineListEditorItem | null>(null);

  const currentSection = useMemo(
    () => sections.find((s) => s.id === activeSection),
    [sections, activeSection],
  );

  const [showAddWine, setShowAddWine] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const [deletingItem, setDeletingItem] = useState(false);
  const [deletingSection, setDeletingSection] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const templateMutationRef = useRef(false);
  const itemMutationSlotsRef = useRef(new Set<string>());
  const sectionMutationSlotsRef = useRef(new Set<string>());

  const totalWines = useMemo(
    () => sections.reduce((sum, s) => sum + s.wine_list_items.length, 0),
    [sections],
  );

  // BND-161: commit inline rename
  const commitRename = useCallback(async () => {
    const id = editingSectionId;
    const name = editSectionName.trim();
    if (!id || !name) {
      setEditingSectionId(null);
      return;
    }
    const activeSlot = `wine-list-section:${id}:active`;
    if (sectionMutationSlotsRef.current.has(activeSlot)) return;
    sectionMutationSlotsRef.current.add(activeSlot);
    const previousName =
      sections.find((section) => section.id === id)?.name ?? name;
    const body = { name };
    const slot =
      `wine-list-section:${id}:patch:${commandIdentity(body)}`;

    setSections((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s)),
    );
    setEditingSectionId(null);

    try {
      const { response, data } =
        await wineListCommands.json<unknown>({
          slot,
          url: `/api/wine-list-sections/${id}`,
          method: "PATCH",
          json: body,
        });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            "Failed to rename section. Please try again.",
          ).message,
        );
      }
      if (!isOkMutation(data)) {
        throw new Error("The server returned an invalid rename response.");
      }
    } catch (error) {
      setSections((prev) =>
        prev.map((section) =>
          section.id === id && section.name === name
            ? { ...section, name: previousName }
            : section,
        ),
      );
      startTransition(() => router.refresh());
      setErrorToast(
        error instanceof Error && error.message
          ? error.message
          : "Failed to rename section. Please try again.",
      );
      setTimeout(() => setErrorToast(null), 4000);
    } finally {
      sectionMutationSlotsRef.current.delete(activeSlot);
    }
  }, [
    editingSectionId,
    editSectionName,
    router,
    sections,
    wineListCommands,
  ]);

  const cancelRename = useCallback(() => {
    setEditingSectionId(null);
  }, []);

  // BND-163: delete section
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    const activeSlot = `wine-list-section:${targetId}:active`;
    if (sectionMutationSlotsRef.current.has(activeSlot)) return;
    sectionMutationSlotsRef.current.add(activeSlot);
    setDeletingSection(true);
    setDeleteTarget(null);

    try {
      const { response, data } =
        await wineListCommands.json<unknown>({
          slot: `wine-list-section:${targetId}:delete`,
          url: `/api/wine-list-sections/${targetId}`,
          method: "DELETE",
        });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            "Failed to delete section. Please try again.",
          ).message,
        );
      }
      if (!isOkMutation(data)) {
        throw new Error("The server returned an invalid delete response.");
      }
      setSections((prev) => {
        const remaining = prev.filter(
          (section) => section.id !== targetId,
        );
        if (activeSection === targetId) {
          setActiveSection(remaining[0]?.id ?? "");
        }
        return remaining;
      });
    } catch (error) {
      startTransition(() => router.refresh());
      setErrorToast(
        error instanceof Error && error.message
          ? error.message
          : "Failed to delete section. Please try again.",
      );
      setTimeout(() => setErrorToast(null), 4000);
    } finally {
      setDeletingSection(false);
      sectionMutationSlotsRef.current.delete(activeSlot);
    }
  }, [
    deleteTarget,
    activeSection,
    router,
    wineListCommands,
  ]);

  const addWineToSection = useCallback(
    async (wineId: string, glassPrice: number | null, bottlePrice: number | null, sectionIds: string[]) => {
      if (sectionIds.length === 0) {
        return { failedSectionIds: [], retryRequired: false };
      }
      const failedSectionIds: string[] = [];
      let retryRequired = false;
      let failureMessage = "Failed to add wine. Please try again.";
      for (const sectionId of sectionIds) {
        const body = {
          section_id: sectionId,
          wine_id: wineId,
          glass_price: glassPrice,
          bottle_price: bottlePrice,
        };
        const slot = `wine-list-item:create:${commandIdentity(body)}`;
        if (itemMutationSlotsRef.current.has(slot)) {
          failedSectionIds.push(sectionId);
          continue;
        }
        itemMutationSlotsRef.current.add(slot);
        try {
          const { response, data } =
            await wineListCommands.json<unknown>({
              slot,
              url: "/api/wine-list-items",
              method: "POST",
              json: body,
            });
          if (!response.ok) {
            failedSectionIds.push(sectionId);
            retryRequired ||= shouldRetainIdempotencyKey(
              response.status,
              readApiErrorCode(data),
            );
            failureMessage = readApiError(data, failureMessage).message;
            continue;
          }
          if (!createdItemId(data)) {
            failedSectionIds.push(sectionId);
            failureMessage = "The server returned an invalid wine-list item.";
          }
        } catch (error) {
          failedSectionIds.push(sectionId);
          retryRequired = true;
          failureMessage =
            error instanceof Error && error.message
              ? error.message
              : failureMessage;
        } finally {
          itemMutationSlotsRef.current.delete(slot);
        }
      }
      if (failedSectionIds.length === 0) {
        setShowAddWine(false);
        startTransition(() => router.refresh());
      } else {
        startTransition(() => router.refresh());
        setErrorToast(failureMessage);
        setTimeout(() => setErrorToast(null), 4000);
      }
      return { failedSectionIds, retryRequired };
    },
    [router, wineListCommands],
  );

  const addSection = useCallback(async () => {
    const raw = window.prompt("New section name");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    const activeSlot = "wine-list-section:create-active";
    if (sectionMutationSlotsRef.current.has(activeSlot)) return;
    sectionMutationSlotsRef.current.add(activeSlot);
    const body = { wine_list_id: list.id, name };

    setAddingSection(true);
    try {
      const { response, data } =
        await wineListCommands.json<unknown>({
          slot: `wine-list-section:create:${commandIdentity(body)}`,
          url: "/api/wine-list-sections",
          method: "POST",
          json: body,
        });
      if (!response.ok) {
        throw new Error(
          readApiError(
            data,
            `Failed to add section (${response.status}).`,
          ).message,
        );
      }
      const id = createdSectionId(data);
      if (!id) {
        throw new Error("The server returned an invalid section.");
      }
      setActiveSection(id);
      startTransition(() => router.refresh());
    } catch (error) {
      startTransition(() => router.refresh());
      setErrorToast(
        error instanceof Error && error.message
          ? error.message
          : "Failed to add section. Please try again.",
      );
      setTimeout(() => setErrorToast(null), 4000);
    } finally {
      setAddingSection(false);
      sectionMutationSlotsRef.current.delete(activeSlot);
    }
  }, [list.id, router, wineListCommands]);

  // BND-162: sensors for section drag-and-drop
  const sectionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // BND-162: handle section reorder drag end
  const handleSectionDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sections.findIndex((s) => s.id === active.id);
      const newIndex = sections.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const activeSlot = "wine-list-section:reorder-active";
      if (sectionMutationSlotsRef.current.has(activeSlot)) return;
      sectionMutationSlotsRef.current.add(activeSlot);

      const previous = sections.map((s) => ({ ...s }));

      const reordered = [...sections];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      setSections(reordered.map((s, i) => ({ ...s, position: i })));

      const orderedIds = reordered.map((section) => section.id);
      try {
        const { response, data } =
          await wineListCommands.json<unknown>({
            slot:
              `wine-list-section:reorder:${list.id}:` +
              commandIdentity(orderedIds),
            url: "/api/wine-list-sections/reorder",
            method: "PATCH",
            json: { orderedIds },
          });
        if (!response.ok) {
          throw new Error(
            readApiError(
              data,
              "Failed to reorder sections. Please try again.",
            ).message,
          );
        }
        if (!isOkMutation(data)) {
          throw new Error(
            "The server returned an invalid section-order response.",
          );
        }
      } catch (error) {
        setSections((current) =>
          restoreWineSectionOrderAfterFailedReorder(current, previous),
        );
        startTransition(() => router.refresh());
        setErrorToast(
          error instanceof Error && error.message
            ? error.message
            : "Failed to reorder sections. Please try again.",
        );
        setTimeout(() => setErrorToast(null), 4000);
      } finally {
        sectionMutationSlotsRef.current.delete(activeSlot);
      }
    },
    [list.id, router, sections, wineListCommands],
  );

  // Wine-item drag sensors (within a section)
  const wineSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !currentSection) return;
      const guardSlot = `wine-list-item:${currentSection.id}:reorder-active`;
      if (itemMutationSlotsRef.current.has(guardSlot)) return;

      const items = [...currentSection.wine_list_items];
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Save previous items order for rollback
      const previousItems = currentSection.wine_list_items.map((i) => ({ ...i }));

      const [moved] = items.splice(oldIndex, 1);
      items.splice(newIndex, 0, moved);
      const orderedIds = items.map((item) => item.id);
      const commandSlot =
        `wine-list-item:reorder:${currentSection.id}:${commandIdentity(orderedIds)}`;

      setSections((prev) =>
        prev.map((s) =>
          s.id === activeSection
            ? { ...s, wine_list_items: items.map((it, idx) => ({ ...it, position: idx })) }
            : s,
        ),
      );

      itemMutationSlotsRef.current.add(guardSlot);
      try {
        const { response, data } =
          await wineListCommands.json<unknown>({
            slot: commandSlot,
            url: "/api/wine-list-items/reorder",
            method: "PATCH",
            json: { orderedIds },
          });
        if (!response.ok) {
          throw new Error(
            readApiError(
              data,
              "Failed to reorder wines. Please try again.",
            ).message,
          );
        }
        if (!isOkMutation(data)) {
          throw new Error("The server returned an invalid reorder response.");
        }
      } catch (error) {
        setSections((prev) =>
          prev.map((s) =>
            s.id === activeSection
              ? {
                  ...s,
                  wine_list_items: restoreWineItemOrderAfterFailedReorder(
                    s.wine_list_items,
                    previousItems,
                  ),
                }
            : s,
          ),
        );
        setErrorToast(
          error instanceof Error && error.message
            ? error.message
            : "Failed to reorder wines. Please try again.",
        );
        setTimeout(() => setErrorToast(null), 4000);
        startTransition(() => router.refresh());
      } finally {
        itemMutationSlotsRef.current.delete(guardSlot);
      }
    },
    [currentSection, activeSection, router, wineListCommands],
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      const slot = `wine-list-item:${itemId}:delete`;
      if (itemMutationSlotsRef.current.has(slot)) return;
      itemMutationSlotsRef.current.add(slot);
      try {
        const { response, data } =
          await wineListCommands.json<unknown>({
            slot,
            url: `/api/wine-list-items/${itemId}`,
            method: "DELETE",
          });
        if (!response.ok) {
          throw new Error(
            readApiError(
              data,
              "Failed to delete wine. Please try again.",
            ).message,
          );
        }
        if (!isOkMutation(data)) {
          throw new Error("The server returned an invalid delete response.");
        }
        setSections((prev) =>
          prev.map((s) => ({
            ...s,
            wine_list_items: s.wine_list_items.filter(
              (item) => item.id !== itemId,
            ),
          })),
        );
      } catch (error) {
        startTransition(() => router.refresh());
        setErrorToast(
          error instanceof Error && error.message
            ? error.message
            : "Failed to delete wine. Please try again.",
        );
        setTimeout(() => setErrorToast(null), 4000);
      } finally {
        itemMutationSlotsRef.current.delete(slot);
      }
    },
    [router, wineListCommands],
  );

  const requestDeleteItem = useCallback(function(item: WineListEditorItem) {
    setWineToDelete(item);
  }, []);

  const confirmDeleteItem = useCallback(async function() {
    const target = wineToDelete;
    if (!target) return;
    setDeletingItem(true);
    setWineToDelete(null);
    try { await deleteItem(target.id); } finally { setDeletingItem(false); }
  }, [wineToDelete, deleteItem]);

  const persistItemUpdate = useCallback(
    async (
      itemId: string,
      body: Record<string, unknown>,
      fallback: string,
    ) => {
      const slot =
        `wine-list-item:${itemId}:patch:${commandIdentity(body)}`;
      if (itemMutationSlotsRef.current.has(slot)) return null;
      itemMutationSlotsRef.current.add(slot);
      try {
        const { response, data } =
          await wineListCommands.json<unknown>({
            slot,
            url: `/api/wine-list-items/${itemId}`,
            method: "PATCH",
            json: body,
          });
        if (!response.ok) {
          throw new Error(readApiError(data, fallback).message);
        }
        if (!isOkMutation(data)) {
          throw new Error("The server returned an invalid update response.");
        }
        return true;
      } catch (error) {
        startTransition(() => router.refresh());
        setErrorToast(
          error instanceof Error && error.message
            ? error.message
            : fallback,
        );
        setTimeout(() => setErrorToast(null), 4000);
        return false;
      } finally {
        itemMutationSlotsRef.current.delete(slot);
      }
    },
    [router, wineListCommands],
  );

  const updateItemPrice = useCallback(
    async (
      itemId: string,
      field: "glass_price" | "bottle_price",
      value: number | null,
    ) => {
      const previousValue = sections
        .flatMap((section) => section.wine_list_items)
        .find((item) => item.id === itemId)?.[field] ?? null;
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, [field]: value } : i,
          ),
        })),
      );

      const succeeded = await persistItemUpdate(
        itemId,
        { [field]: value },
        "Failed to update price. Please try again.",
      );
      if (succeeded === false) {
        setSections((prev) =>
          prev.map((section) => ({
            ...section,
            wine_list_items: section.wine_list_items.map((item) =>
              item.id === itemId && item[field] === value
                ? { ...item, [field]: previousValue }
                : item,
            ),
          })),
        );
      }
    },
    [persistItemUpdate, sections],
  );

  const updateItemPour = useCallback(
    async (
      itemId: string,
      field: "glass_pour_ml" | "pour_size_mode",
      value: number | "fixed" | "picker" | null,
    ) => {
      const previousItem = sections
        .flatMap((section) => section.wine_list_items)
        .find((item) => item.id === itemId);
      const previousValue =
        field === "glass_pour_ml"
          ? previousItem?.glass_pour_ml ?? null
          : previousItem?.pour_size_mode ?? "fixed";
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, [field]: value } : i,
          ),
        })),
      );

      const succeeded = await persistItemUpdate(
        itemId,
        { [field]: value },
        "Failed to update pour settings. Please try again.",
      );
      if (succeeded === false) {
        setSections((prev) =>
          prev.map((section) => ({
            ...section,
            wine_list_items: section.wine_list_items.map((item) =>
              item.id === itemId && item[field] === value
                ? { ...item, [field]: previousValue }
                : item,
            ),
          })),
        );
      }
    },
    [persistItemUpdate, sections],
  );

  const updateItemName = useCallback(
    async (itemId: string, value: string | null) => {
      const previousValue = sections
        .flatMap((section) => section.wine_list_items)
        .find((item) => item.id === itemId)?.name_override ?? null;
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, name_override: value } : i,
          ),
        })),
      );

      const succeeded = await persistItemUpdate(
        itemId,
        { name_override: value },
        "Failed to update name. Please try again.",
      );
      if (succeeded === false) {
        setSections((prev) =>
          prev.map((section) => ({
            ...section,
            wine_list_items: section.wine_list_items.map((item) =>
              item.id === itemId && item.name_override === value
                ? { ...item, name_override: previousValue }
                : item,
            ),
          })),
        );
      }
    },
    [persistItemUpdate, sections],
  );
  const updateItemBlurb = useCallback(
    async (itemId: string, value: string | null) => {
      const previousValue = sections
        .flatMap((section) => section.wine_list_items)
        .find((item) => item.id === itemId)?.blurb ?? null;
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, blurb: value } : i,
          ),
        })),
      );

      const succeeded = await persistItemUpdate(
        itemId,
        { blurb: value },
        "Failed to update blurb. Please try again.",
      );
      if (succeeded === false) {
        setSections((prev) =>
          prev.map((section) => ({
            ...section,
            wine_list_items: section.wine_list_items.map((item) =>
              item.id === itemId && item.blurb === value
                ? { ...item, blurb: previousValue }
                : item,
            ),
          })),
        );
      }
    },
    [persistItemUpdate, sections],
  );

  const updateItemHidden = useCallback(
    async (itemId: string, value: boolean) => {
      const previousValue =
        sections
          .flatMap((section) => section.wine_list_items)
          .find((item) => item.id === itemId)?.hidden ?? false;
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          wine_list_items: s.wine_list_items.map((i) =>
            i.id === itemId ? { ...i, hidden: value } : i,
          ),
        })),
      );

      const succeeded = await persistItemUpdate(
        itemId,
        { hidden: value },
        "Failed to update visibility. Please try again.",
      );
      if (succeeded === false) {
        setSections((prev) =>
          prev.map((section) => ({
            ...section,
            wine_list_items: section.wine_list_items.map((item) =>
              item.id === itemId && item.hidden === value
                ? { ...item, hidden: previousValue }
                : item,
            ),
          })),
        );
      }
    },
    [persistItemUpdate, sections],
  );

  const downloadPdf = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId: list.id }),
      });
      if (!res.ok) throw new Error("PDF generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${list.name}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setGeneratingPdf(false);
    }
  }, [list.id, list.name]);

  const copyUrl = useCallback(() => {
    if (!list.slug) return;
    const url = `${window.location.origin}/list/${list.slug}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2500);
    }).catch(() => {
      // Clipboard API may fail in insecure contexts — silently ignore.
    });
  }, [list.slug]);

  const updateTemplate = useCallback(
    async (template: Template) => {
      if (templateMutationRef.current) return;
      templateMutationRef.current = true;
      setTemplateBusy(true);
      const slot = `wine-list:${list.id}:template`;
      try {
        const { response, data } =
          await wineListCommands.json<unknown>({
            slot,
            url: `/api/wine-lists/${list.id}`,
            method: "PATCH",
            json: { template },
          });
        if (!response.ok) {
          setErrorToast(
            readApiError(
              data,
              "Failed to update template. Please try again.",
            ).message,
          );
          setTimeout(() => setErrorToast(null), 4000);
          return;
        }
        if (
          typeof data !== "object" ||
          data === null ||
          (data as { ok?: unknown }).ok !== true
        ) {
          throw new Error("The server returned an invalid response.");
        }
        startTransition(() => router.refresh());
      } catch (error) {
        setErrorToast(
          error instanceof Error && error.message
            ? error.message
            : "Failed to update template. Please try again.",
        );
        setTimeout(() => setErrorToast(null), 4000);
      } finally {
        templateMutationRef.current = false;
        setTemplateBusy(false);
      }
    },
    [list.id, router, wineListCommands],
  );

  return (
    <section>
      {/* Header */}
      <header className="mb-lg md:mb-xl">
        <Link
          href="/lists"
          className="mb-sm inline-flex items-center gap-xs text-[13px] text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          All lists
        </Link>
        <div className="flex flex-col gap-sm md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="font-serif text-[28px] text-ink">{list.name}</h1>
            <p className="mt-xs text-[13px] text-ink-muted">
              {list.is_published ? (
                <span className="mr-sm inline-flex items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[11px] font-medium text-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                  Published
                </span>
              ) : (
                <span className="mr-sm inline-flex items-center gap-xs rounded-pill bg-surface-sunken px-sm py-xs text-[11px] font-medium text-ink-muted">
                  Draft
                </span>
              )}
              {totalWines} wines
            </p>
          </div>
          <div className="flex gap-sm self-start md:self-auto">
            <button
              type="button"
              onClick={downloadPdf}
              disabled={generatingPdf}
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-60 md:px-md"
            >
              {generatingPdf ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              <span className="hidden md:inline">{generatingPdf ? "Generating..." : "Download PDF"}</span>
            </button>
            <a
              href="/api/export/toast-csv"
              download="toast-import.csv"
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Toast Export</span>
            </a>
            <a
              href={`/api/wine-lists/${list.id}/csv`}
              download
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <FileText className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">CSV</span>
            </a>
            {/* BND-172: Preview button */}
            <a
              href={`/lists/${list.id}/preview`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Preview</span>
            </a>
            <a
              href={`/lists/${list.id}/print`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
            >
              <Printer className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Print</span>
            </a>
            {list.is_published && list.slug && (
              <button
                type="button"
                onClick={copyUrl}
                className="flex h-[34px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[13px] font-medium text-ink hover:bg-surface-muted md:px-md"
              >
                <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                <span className="hidden md:inline">Copy URL</span>
              </button>
            )}
                        <button
              type="button"
              onClick={() => setShowPublish(true)}
              className="flex h-[34px] items-center gap-xs rounded-sm bg-accent px-sm text-[13px] font-medium text-white hover:bg-accent-hover md:px-md"
            >
              <Share2 className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden md:inline">Publish</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile section dropdown */}
      <div className="relative mb-md md:hidden">
        <select
          value={activeSection}
          onChange={(e) => setActiveSection(e.target.value)}
          className="h-11 w-full appearance-none rounded-sm border border-border bg-white px-sm pr-xl text-[14px] font-medium text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.wine_list_items.length})
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-sm top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
      </div>

      {/* Desktop: sidebar + content */}
      <div className="md:grid md:grid-cols-[220px_1fr] md:gap-lg">
        {/* Desktop sidebar */}
        <aside className="hidden md:block">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Sections
          </div>
          <div className="mt-sm flex flex-col gap-2xs">
            <DndContext
              sensors={sectionSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleSectionDragEnd}
            >
              <SortableContext
                items={sections.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                {sections.map((s) => (
                  <SortableSectionButton
                    key={s.id}
                    section={s}
                    isActive={activeSection === s.id}
                    onSelect={() => setActiveSection(s.id)}
                    onDelete={setDeleteTarget}
                    editingId={editingSectionId}
                    editName={editSectionName}
                    onEditStart={(id, name) => {
                      setEditingSectionId(id);
                      setEditSectionName(name);
                    }}
                    onEditChange={setEditSectionName}
                    onEditCommit={commitRename}
                    onEditCancel={cancelRename}
                    editRef={editInputRef}
                  />
                ))}
              </SortableContext>
            </DndContext>
            <button
              type="button"
              onClick={addSection}
              disabled={addingSection}
              className="flex items-center gap-xs px-sm py-xs text-[13px] text-ink-subtle hover:text-ink disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Add section
            </button>
          </div>

          <div className="mt-lg text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
            Template
          </div>
          <div className="mt-sm">
            <TemplatePicker
              current={list.template}
              onChange={updateTemplate}
              disabled={isPending || templateBusy}
            />
          </div>
        </aside>

        {/* Main content — active section */}
        {currentSection && (
          <div className="rounded-md border border-border bg-surface">
            {/* Section header */}
            <div className="flex items-center justify-between border-b border-border px-md py-md md:px-lg">
              <div>
                <h2 className="font-serif text-[22px] font-medium text-ink md:text-[26px]">
                  {currentSection.name}
                </h2>
                <p className="mt-2xs text-[13px] text-ink-muted">
                  {currentSection.wine_list_items.length} wines
                </p>
              </div>
              <div className="flex gap-sm">
                <button
                  type="button"
                  onClick={() => setShowAddWine(true)}
                  className="flex h-[30px] items-center gap-xs rounded-sm bg-accent px-sm text-[13px] font-medium text-white hover:bg-accent-hover"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  <span className="hidden sm:inline">Add wine</span>
                </button>
              </div>
            </div>

            {/* Wine items */}
            {currentSection.wine_list_items.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-lg py-3xl text-center">
                <p className="text-[14px] text-ink-muted">
                  No wines in this section yet.
                </p>
                <p className="mt-xs text-[13px] text-ink-subtle">
                  Add wines from your inventory or scan a new invoice.
                </p>
              </div>
            ) : (
              <DndContext
                sensors={wineSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={currentSection.wine_list_items.map((i) => i.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div>
                    {/* Desktop table header */}
                    <div className="hidden border-b border-border bg-surface-muted px-lg py-xs md:grid md:grid-cols-[28px_1fr_80px_80px_36px]">
                      <div />
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                        Wine
                      </div>
                      <div className="text-right text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                        Glass
                      </div>
                      <div className="text-right text-[11px] font-medium uppercase tracking-[0.08em] text-ink-subtle">
                        Bottle
                      </div>
                      <div />
                    </div>

                    {currentSection.wine_list_items.map((item) => (
                      <SortableWineRow
                        key={item.id}
                        item={item}
                        onDelete={() => requestDeleteItem(item)}
                        onPriceChange={updateItemPrice}
                        onPourChange={updateItemPour}
                        onNameChange={updateItemName}
                        onBlurbChange={updateItemBlurb}
                        onHiddenChange={updateItemHidden}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Add another wine footer */}
            <div className="border-t border-dashed border-border px-lg py-md text-center">
              <button
                type="button"
                onClick={() => setShowAddWine(true)}
                className="text-[13px] text-ink-subtle hover:text-ink"
              >
                <Plus
                  className="mr-xs inline-block h-3.5 w-3.5"
                  strokeWidth={2}
                />
                Add another wine to {currentSection.name}
              </button>
            </div>
          </div>
        )}
      </div>

            {/* Delete wine confirmation dialog (BND-194) */}
      {wineToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-md">
          <div className="w-full max-w-sm rounded-lg border border-border bg-white shadow-xl">
            <div className="px-lg py-lg">
              <div className="flex items-start justify-between">
                <h3 className="font-serif text-[18px] font-medium text-ink">
                  Remove wine
                </h3>
                <button
                  type="button"
                  onClick={function() { setWineToDelete(null); }}
                  className="rounded-sm p-1 text-ink-subtle hover:text-ink"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <p className="mt-sm text-[14px] text-ink-muted leading-relaxed">
                Remove{" "}
                <strong className="text-ink">{wineToDelete.wines.producer}, {wineToDelete.wines.name}</strong>
                {wineToDelete.wines.vintage && <span> ({wineToDelete.wines.vintage})</span>}
                {" "}from this wine list?
              </p>
              <p className="mt-xs text-[13px] text-ink-subtle">
                The wine will remain in your cellar inventory.
              </p>
              <div className="mt-lg flex justify-end gap-sm">
                <button
                  type="button"
                  onClick={function() { setWineToDelete(null); }}
                  className="rounded-sm border border-border px-md py-1.5 text-[13px] font-medium text-ink-muted hover:bg-surface-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteItem}
                  disabled={deletingItem}
                  className="rounded-sm bg-danger px-md py-1.5 text-[13px] font-medium text-white hover:bg-danger-hover disabled:opacity-60"
                >
                  Remove wine
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog (BND-163) */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-md">
          <div className="w-full max-w-sm rounded-lg border border-border bg-white shadow-xl">
            <div className="px-lg py-lg">
              <div className="flex items-start justify-between">
                <h3 className="font-serif text-[18px] font-medium text-ink">
                  Delete section
                </h3>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  className="rounded-sm p-1 text-ink-subtle hover:text-ink"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
              <p className="mt-sm text-[14px] text-ink-muted leading-relaxed">
                Are you sure you want to delete{" "}
                <strong className="text-ink">{deleteTarget.name}</strong>?
              </p>
              {deleteTarget.wine_list_items.length > 0 && (
                <p className="mt-sm rounded-sm bg-danger-soft px-sm py-sm text-[13px] text-danger font-medium">
                  This will permanently remove{" "}
                  {deleteTarget.wine_list_items.length} wine
                  {deleteTarget.wine_list_items.length !== 1 ? "s" : ""} from
                  this list.
                </p>
              )}
              <div className="mt-lg flex justify-end gap-sm">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  className="rounded-sm border border-border px-md py-1.5 text-[13px] font-medium text-ink-muted hover:bg-surface-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  disabled={deletingSection}
                  className="rounded-sm bg-danger px-md py-1.5 text-[13px] font-medium text-white hover:bg-danger-hover disabled:opacity-60"
                >
                  Delete section
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAddWine && currentSection && (
        <AddWineModal
          sections={sections.map((s) => ({ id: s.id, name: s.name }))}
          activeSectionId={activeSection}
          onAdd={addWineToSection}
          onClose={() => setShowAddWine(false)}
        />
      )}

      {showPublish && (
        <PublishModal
          listId={list.id}
          currentSlug={list.slug}
          isPublished={list.is_published}
          onClose={() => {
            setShowPublish(false);
            startTransition(() => router.refresh());
          }}
        />
      )}

      {/* Error toast for failed drag-and-drop reorders */}
      {errorToast && (
        <div className="fixed bottom-lg left-1/2 z-50 -translate-x-1/2 rounded-md bg-danger px-lg py-sm text-[13px] font-medium text-white shadow-lg animate-in fade-in slide-in-from-bottom-2">
          {errorToast}
        </div>
      )}

      {/* Copy URL toast */}
      {copyFeedback && (
        <div className="fixed bottom-lg left-1/2 z-50 -translate-x-1/2 rounded-md bg-ink px-lg py-sm text-[13px] font-medium text-white shadow-lg animate-in fade-in slide-in-from-bottom-2">
          URL copied to clipboard.
        </div>
      )}
    </section>
  );
}
