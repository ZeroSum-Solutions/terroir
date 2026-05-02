"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ListOrdered, Plus } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type { WineListWithCount } from "@/lib/wine-list/types";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function WineListLanding({
  lists,
}: {
  lists: WineListWithCount[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Per-card "copied" indicator for the published-list footer — tracks
  // the list id whose public link was most recently copied so we can
  // flash a confirmation on that card only. Mirrors the team-page
  // per-row invitation copy pattern.
  const [copiedListId, setCopiedListId] = useState<string | null>(null);

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

  const createList = useCallback(async () => {
    const name = newName.trim() || "Untitled Wine List";
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/wine-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to create wine list");
      const { id } = (await res.json()) as { id: string };
      router.push(`/lists/${id}`);
    } catch {
      setCreateError("Couldn't create wine list. Please try again.");
      setCreating(false);
    }
  }, [newName, router]);

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
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="flex h-[38px] items-center gap-sm self-start rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover md:self-auto"
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          New wine list
        </button>
      </header>

      {lists.length === 0 ? (
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
        <div className="grid gap-md md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
          {lists.map((list) => {
            const justCopied = copiedListId === list.id;
            const showCopyAction = list.is_published && list.slug;
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
                    {list.is_published ? (
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
                  <div className="mt-md flex items-center justify-between text-[12px] text-ink-muted">
                    <span>
                      <span className="font-medium text-ink">
                        {list.wine_count}
                      </span>{" "}
                      wines
                    </span>
                    <span>Updated {timeAgo(list.updated_at)}</span>
                  </div>
                </button>
                {showCopyAction && (
                  // Sibling (not nested) so we don't end up with a
                  // button-inside-button — invalid HTML the parser
                  // would silently un-nest.
                  <div className="border-t border-border px-md py-sm">
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
                  </div>
                )}
              </div>
            );
          })}
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

      {/* Create modal */}
      {showModal && (
        <CreateListModal
          newName={newName}
          setNewName={(v) => {
            setNewName(v);
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
  creating,
  error,
  onClose,
  onCreate,
}: {
  newName: string;
  setNewName: (v: string) => void;
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
