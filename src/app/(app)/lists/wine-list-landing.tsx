"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  Files,
  ListOrdered,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { TimeAgo } from "@/components/time-ago";
import type { WineListWithCount } from "@/lib/wine-list/types";

function isOkMutation(data: unknown): data is { ok: true } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { ok?: unknown }).ok === true
  );
}

function createdListId(data: unknown): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return (data as { id: string }).id;
}

export function WineListLanding({
  lists,
  archivedLists = [],
  showArchived = false,
}: {
  lists: WineListWithCount[];
  archivedLists?: WineListWithCount[];
  showArchived?: boolean;
}) {
  const router = useRouter();
  const [commands] = useState(() =>
    createIdempotentCommandStore({
      persistence: createSessionCommandPersistence(
        "terroir:wine-list-lifecycle",
      ),
    }),
  );
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Per-card "copied" indicator for the published-list footer — tracks
  // the list id whose public link was most recently copied so we can
  // flash a confirmation on that card only. Mirrors the team-page
  // per-row invitation copy pattern.
  const [copiedListId, setCopiedListId] = useState<string | null>(null);
  // Tracks the list id currently being deleted so we can disable its
  // Delete button while the request is in flight. Surface API errors in
  // an inline alert above the grid so the user sees what failed.
  const [deletingListId, setDeletingListId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Tracks which list is being archived/unarchived
  const [archivingListId, setArchivingListId] = useState<string | null>(null);
  // Tracks which list is being cloned
  const [cloningListId, setCloningListId] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const activeMutationSlotsRef = useRef(new Set<string>());

  const copyListLink = useCallback(async (list: WineListWithCount) => {
    if (!list.slug) return;
    const url = `${window.location.origin}/list/${list.slug}`;
    await navigator.clipboard.writeText(url);
    setCopiedListId(list.id);
    setTimeout(
      () =>
        setCopiedListId((current) => (current === list.id ? null : current)),
      2000,
    );
  }, []);

  const toggleArchive = useCallback(
    async (list: WineListWithCount) => {
      const slot = `wine-list:${list.id}:archive`;
      if (activeMutationSlotsRef.current.has(slot)) return;
      const willArchive = !list.archived;
      const action = willArchive ? "archive" : "unarchive";
      const confirmMessage = willArchive
        ? `Archive "${list.name}"? It will be hidden from the default view but can be restored later.`
        : `Restore "${list.name}"? It will appear in the default view again.`;
      if (!window.confirm(confirmMessage)) return;

      activeMutationSlotsRef.current.add(slot);
      setArchivingListId(list.id);
      try {
        const { response, data } = await commands.json<unknown>({
          slot,
          url: `/api/wine-lists/${list.id}`,
          method: "PATCH",
          json: { archived: willArchive },
        });
        if (!response.ok) {
          throw new Error(
            readApiError(data, `Couldn't ${action} wine list.`).message,
          );
        }
        if (!isOkMutation(data)) {
          throw new Error(`Couldn't ${action} wine list.`);
        }
        router.refresh();
      } catch (err) {
        setDeleteError(
          err instanceof Error && err.message
            ? err.message
            : `Couldn't ${action} wine list. Please try again.`,
        );
      } finally {
        activeMutationSlotsRef.current.delete(slot);
        setArchivingListId(null);
      }
    },
    [commands, router],
  );

  const deleteList = useCallback(
    async (list: WineListWithCount) => {
      // BND-159: only archived lists can be deleted. The API enforces this,
      // but the UI should never call DELETE on a non-archived list — archive
      // first.
      if (!list.archived) return;
      const slot = `wine-list:${list.id}:delete`;
      if (activeMutationSlotsRef.current.has(slot)) return;

      const confirmMessage = list.is_published
        ? `Permanently delete "${list.name}"? This list is currently published — its public link will stop working immediately. This cannot be undone.`
        : `Permanently delete "${list.name}"? Its sections and items will be removed. This cannot be undone.`;
      if (!window.confirm(confirmMessage)) return;

      activeMutationSlotsRef.current.add(slot);
      setDeleteError(null);
      setDeletingListId(list.id);
      try {
        const { response, data } = await commands.json<unknown>({
          slot,
          url: `/api/wine-lists/${list.id}`,
          method: "DELETE",
          parse: "json",
        });
        if (!response.ok) {
          throw new Error(
            readApiError(data, "Couldn't delete wine list.").message,
          );
        }
        if (!isOkMutation(data)) {
          throw new Error("Couldn't delete wine list.");
        }
        router.refresh();
      } catch (err) {
        setDeleteError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't delete wine list. Please try again.",
        );
      } finally {
        activeMutationSlotsRef.current.delete(slot);
        setDeletingListId(null);
      }
    },
    [commands, router],
  );

  const cloneList = useCallback(
    async (list: WineListWithCount) => {
      const slot = `wine-list:${list.id}:clone`;
      if (activeMutationSlotsRef.current.has(slot)) return;
      const confirmMessage = `Clone "${list.name}"? A new unpublished copy will be created with all sections and items preserved.`;
      if (!window.confirm(confirmMessage)) return;

      activeMutationSlotsRef.current.add(slot);
      setDeleteError(null);
      setCloningListId(list.id);
      try {
        const { response, data } = await commands.json<unknown>({
          slot,
          url: `/api/wine-lists/${list.id}/clone`,
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(
            readApiError(data, "Clone failed. Please try again.").message,
          );
        }
        const id = createdListId(data);
        if (!id) {
          throw new Error("The server returned an invalid wine-list clone.");
        }
        router.refresh();
        router.push(`/lists/${id}`);
      } catch (err) {
        setDeleteError(
          err instanceof Error && err.message
            ? err.message
            : "Clone failed. Please try again.",
        );
      } finally {
        activeMutationSlotsRef.current.delete(slot);
        setCloningListId(null);
      }
    },
    [commands, router],
  );

  const createList = useCallback(async () => {
    if (creatingRef.current) return;
    const name = newName.trim() || "Untitled Wine List";
    const slot = "wine-list:create";
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const body: { name: string; description?: string } = { name };
      if (newDescription.trim()) {
        body.description = newDescription.trim();
      }
      const { response, data } = await commands.json<unknown>({
        slot,
        url: "/api/wine-lists",
        method: "POST",
        json: body,
      });
      if (!response.ok) {
        throw new Error(
          readApiError(data, "Couldn't create wine list.").message,
        );
      }
      const id = createdListId(data);
      if (!id) {
        throw new Error("The server returned an invalid wine list.");
      }
      router.push(`/lists/${id}`);
    } catch (error) {
      setCreateError(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't create wine list. Please try again.",
      );
      creatingRef.current = false;
      setCreating(false);
    }
  }, [commands, newName, newDescription, router]);

  const renderCard = (list: WineListWithCount) => {
    const justCopied = copiedListId === list.id;
    const showCopyAction = list.is_published && list.slug;
    const isDeleting = deletingListId === list.id;
    const isArchiving = archivingListId === list.id;
    const isCloning = cloningListId === list.id;
    return (
      <div
        key={list.id}
        className="group rounded-md border border-border bg-surface transition-all hover:-translate-y-px hover:border-border-strong hover:shadow-md"
      >
        <button
          type="button"
          onClick={() => router.push(`/lists/${list.id}`)}
          className="block w-full rounded-md p-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          <div className="flex items-start justify-between gap-sm">
            <h3 className="font-serif text-[18px] text-ink group-hover:text-accent">
              {list.name}
            </h3>
            <div className="flex items-center gap-xs">
              {list.archived ? (
                <span className="shrink-0 rounded-pill bg-surface-sunken px-sm py-xs text-[11px] font-medium text-ink-subtle">
                  Archived
                </span>
              ) : list.is_published ? (
                <span className="flex shrink-0 items-center gap-xs rounded-pill bg-success-soft px-sm py-xs text-[11px] font-medium text-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                  Published
                </span>
              ) : (
                <span className="shrink-0 rounded-pill bg-surface-sunken px-sm py-xs text-[11px] font-medium text-ink-muted">
                  Draft
                </span>
              )}
            </div>
          </div>
          {list.description && (
            <p className="mt-xs text-[13px] text-ink-muted line-clamp-2">
              {list.description}
            </p>
          )}
          <div className="mt-md flex items-center justify-between text-[12px] text-ink-muted">
            <span>
              <span className="font-medium text-ink">
                {list.wine_count}
              </span>{" "}
              wines
            </span>
            {list.is_published ? (
              <span>
                Published{" "}
                <TimeAgo
                  iso={list.last_published_at ?? list.updated_at}
                />
              </span>
            ) : (
              <span>
                Updated <TimeAgo iso={list.updated_at} />
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center justify-between gap-xs border-t border-border px-md py-sm">
          <div className="flex items-center gap-xs">
            {showCopyAction && (
              <>
                <button
                  type="button"
                  onClick={() => copyListLink(list)}
                  aria-label={`Copy public link for ${list.name}`}
                  className="inline-flex h-[28px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  {justCopied ? (
                    <Check
                      className="h-3.5 w-3.5"
                      strokeWidth={2}
                      aria-hidden
                    />
                  ) : (
                    <Copy
                      className="h-3.5 w-3.5"
                      strokeWidth={2}
                      aria-hidden
                    />
                  )}
                  {justCopied ? "Copied" : "Copy link"}
                </button>
                <a
                  href={`/list/${list.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open public ${list.name} list in a new tab`}
                  className="inline-flex h-[28px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                >
                  <ExternalLink
                    className="h-3.5 w-3.5"
                    strokeWidth={2}
                    aria-hidden
                  />
                  Open
                </a>
              </>
            )}
            {/* Clone button — available for all lists */}
            <button
              type="button"
              onClick={() => cloneList(list)}
              disabled={isCloning}
              aria-label={`Clone ${list.name}`}
              className="inline-flex h-[28px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-60"
            >
              <Files className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Clone
            </button>
          </div>
          <div className="flex items-center gap-xs">
            <button
              type="button"
              onClick={() => toggleArchive(list)}
              disabled={isArchiving}
              aria-label={
                list.archived
                  ? `Restore ${list.name}`
                  : `Archive ${list.name}`
              }
              className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-sm border border-border-strong bg-white text-ink-subtle hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-60"
            >
              {list.archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              ) : (
                <Archive className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              )}
            </button>
            {/* BND-159: Delete button only shown for archived lists */}
            {list.archived && (
              <button
                type="button"
                onClick={() => deleteList(list)}
                disabled={isDeleting}
                aria-label={`Permanently delete ${list.name}`}
                className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-sm border border-border-strong bg-white text-ink-subtle hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const noListsAtAll = lists.length === 0 && archivedLists.length === 0;

  return (
    <section>
      <header className="mb-lg flex flex-col gap-sm md:mb-xl md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-serif text-[28px] text-ink">Wine Lists</h1>
          <p className="mt-xs text-[15px] text-ink-muted">
            Build, publish, and share your menus. Data entered here becomes your
            inventory automatically.
          </p>
        </div>
        <div className="flex items-center gap-sm">
          {archivedLists.length > 0 && (
            <a
              href={showArchived ? "/lists" : "/lists?show_archived=1"}
              className="flex h-[38px] items-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted self-start md:self-auto"
            >
              <Archive className="h-4 w-4" strokeWidth={2} />
              {showArchived ? "Hide archived" : `Show archived (${archivedLists.length})`}
            </a>
          )}
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="flex h-[38px] items-center gap-sm self-start rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover md:self-auto"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            New wine list
          </button>
        </div>
      </header>

      {deleteError && (
        <div
          role="alert"
          className="mb-md flex items-start justify-between gap-sm rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[13px] text-danger"
        >
          <span>{deleteError}</span>
          <button
            type="button"
            onClick={() => setDeleteError(null)}
            aria-label="Dismiss error"
            className="-mr-2xs flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-danger/70 hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}

      {noListsAtAll ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-3xl text-center">
          <ListOrdered
            className="mb-md h-10 w-10 text-ink-subtle"
            strokeWidth={1.5}
          />
          <p className="text-[15px] font-medium text-ink">
            Create your first wine list
          </p>
          <p className="mt-xs text-[13px] text-ink-muted">
            Your guests will thank you.
          </p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="mt-lg flex h-[38px] items-center gap-sm rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            New wine list
          </button>
        </div>
      ) : (
        <>
          {/* Active lists */}
          {lists.length > 0 && (
            <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
              {lists.map(renderCard)}
              <button
                type="button"
                onClick={() => setShowModal(true)}
                className="flex flex-col items-center justify-center gap-sm rounded-md border border-dashed border-border-strong p-xl text-center text-ink-subtle transition-colors hover:border-accent hover:text-accent"
              >
                <Plus className="h-5 w-5" strokeWidth={2} />
                <span className="text-[14px] font-medium">Create a new list</span>
                <span className="text-[12px]">Start from scratch or a template</span>
              </button>
            </div>
          )}

          {/* Archived lists (shown when toggled) */}
          {showArchived && archivedLists.length > 0 && (
            <div className="mt-xl">
              <h2 className="mb-md font-serif text-[20px] text-ink-muted">
                Archived
              </h2>
              <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                {archivedLists.map(renderCard)}
              </div>
            </div>
          )}

          {/* All lists are archived, none active */}
          {lists.length === 0 && !showArchived && archivedLists.length > 0 && (
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted px-lg py-3xl text-center">
              <Archive
                className="mb-md h-10 w-10 text-ink-subtle"
                strokeWidth={1.5}
              />
              <p className="text-[15px] font-medium text-ink">
                All wine lists are archived
              </p>
              <p className="mt-xs text-[13px] text-ink-muted">
                Restore them or create a new one.
              </p>
              <Link
                href="/lists?show_archived=1"
                className="mt-lg inline-flex h-[38px] items-center gap-sm rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted"
              >
                <Archive className="h-4 w-4" strokeWidth={2} />
                Show archived lists
              </Link>
            </div>
          )}
        </>
      )}

      {/* Create modal */}
      {showModal && (
        <CreateListModal
          newName={newName}
          setNewName={(v) => {
            setNewName(v);
            if (createError) setCreateError(null);
          }}
          newDescription={newDescription}
          setNewDescription={(v) => {
            setNewDescription(v);
            if (createError) setCreateError(null);
          }}
          creating={creating}
          error={createError}
          onClose={() => {
            setShowModal(false);
            setCreateError(null);
          }}
          onCreate={createList}
        />
      )}
    </section>
  );
}

function CreateListModal({
  newName,
  setNewName,
  newDescription,
  setNewDescription,
  creating,
  error,
  onClose,
  onCreate,
}: {
  newName: string;
  setNewName: (v: string) => void;
  newDescription: string;
  setNewDescription: (v: string) => void;
  creating: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: () => void;
}) {
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ containerRef: trapRef, onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-wine-list-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="w-full max-w-[400px] rounded-md border border-border bg-surface p-lg shadow-lg"
      >
        <h2
          id="new-wine-list-title"
          className="font-serif text-[22px] text-ink"
        >
          New wine list
        </h2>
        <p className="mt-xs text-[13px] text-ink-muted">
          Default sections will be created. You can rename or add more later.
        </p>
        <input
          autoFocus
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreate();
          }}
          placeholder="Spring 2026 Wine List…"
          className="mt-lg h-[38px] w-full rounded-sm border border-border bg-white px-sm text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        />
        <textarea
          value={newDescription}
          onChange={(e) => setNewDescription(e.target.value)}
          placeholder="Description (optional)"
          rows={3}
          className="mt-sm w-full rounded-sm border border-border bg-white px-sm py-xs text-[14px] text-ink placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft resize-none"
        />
        {error && (
          <p
            role="alert"
            className="mt-sm rounded-sm border border-danger/30 bg-danger-soft px-sm py-xs text-[13px] text-danger"
          >
            {error}
          </p>
        )}
        <div className="mt-lg flex justify-end gap-sm">
          <button
            type="button"
            onClick={onClose}
            className="h-[38px] rounded-sm border border-border-strong px-md text-[14px] font-medium text-ink hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="h-[38px] rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
