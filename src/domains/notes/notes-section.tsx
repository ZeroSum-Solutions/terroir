"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { NoteComposer, type ComposerTerm, type NoteDraft } from "./note-composer";
import { NoteList, type HouseNote } from "./note-list";

type NotesSectionProps = {
  wineId: string;
  vocabulary: ComposerTerm[];
  notes: HouseNote[];
};

/**
 * The house tasting log on one wine: write a note, then read the ones already
 * there. Phase 1 of the wine page — the aggregate taste block in phase 2 is
 * built on exactly this corpus.
 */
export function NotesSection({ wineId, vocabulary, notes }: NotesSectionProps) {
  const router = useRouter();

  const save = useCallback(
    async (draft: NoteDraft) => {
      const response = await fetch(`/api/wines/${wineId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      // The composer keeps everything the author typed when this throws, so a
      // failed save is recoverable rather than a lost note.
      if (!response.ok) throw new Error("save failed");
      router.refresh();
    },
    [wineId, router],
  );

  const suggest = useCallback(async (body: string) => {
    const response = await fetch(`/api/wines/${wineId}/notes/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    return Array.isArray((payload as { slugs?: unknown }).slugs)
      ? ((payload as { slugs: string[] }).slugs)
      : [];
  }, [wineId]);

  return (
    <div className="flex flex-col gap-xl">
      <NoteComposer vocabulary={vocabulary} onSave={save} suggest={suggest} />
      <NoteList notes={notes} />
    </div>
  );
}
