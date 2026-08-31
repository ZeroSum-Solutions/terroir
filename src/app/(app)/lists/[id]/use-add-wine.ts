"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { SearchWine } from "./components/add-wine-modal.types";
import type {
  WineListEditorItem,
  WineListEditorSection,
} from "./wine-list-editor.types";

/**
 * LIST-06 — adding a wine to a list did not register.
 *
 * Three independent causes, all handled here:
 *
 *  A. `addWineToSection` was the only mutation handler in the editor that did
 *     not call `setSections`; it relied on `router.refresh()` alone. The
 *     refreshed server props arrive, but `useState(initialSections)` treats a
 *     prop as an *initializer*, so the new value was dropped and the row never
 *     appeared. The row was in the database the whole time.
 *  B. Post-LIST-02 the wine is filed into the section matching its own colour,
 *     which is often not the section on screen — so even a correct write was
 *     invisible. The caller is told which sections took the wine so it can go
 *     there.
 *  C. A failed POST set a local flag and surfaced nothing. The outcome now
 *     names exactly what landed and what did not, including the partial case
 *     where one section of a multi-section add succeeds and another fails.
 *
 * State is *appended to* rather than resynced from the server, so an edit made
 * while the POST is in flight (a price, a blurb, a reorder) is not clobbered.
 */

export type AddWineRequest = {
  wine: SearchWine;
  glassPrice: number | null;
  bottlePrice: number | null;
  /** LIST-03 — carried onto the new row so it shows a suggestion, not "—". */
  suggestedGlassPrice: number | null;
  suggestedBottlePrice: number | null;
  sectionIds: string[];
};

export type CreatedItem = { sectionId: string; itemId: string };

export type AddWineOutcome = {
  created: CreatedItem[];
  failedSectionIds: string[];
};

/** The row the server just created, in the shape the editor renders. */
export function buildAddedItem(
  itemId: string,
  sectionId: string,
  request: AddWineRequest,
  position: number,
): WineListEditorItem {
  const { wine } = request;
  return {
    id: itemId,
    section_id: sectionId,
    wine_id: wine.id,
    position,
    glass_price: request.glassPrice,
    bottle_price: request.bottlePrice,
    suggested_glass_price: request.suggestedGlassPrice,
    suggested_bottle_price: request.suggestedBottlePrice,
    // Column defaults, from 0016_pour_tracking.sql and the table definition.
    glass_pour_ml: null,
    pour_size_mode: "fixed",
    tasting_note: null,
    name_override: null,
    blurb: null,
    hidden: false,
    wines: {
      id: wine.id,
      name: wine.name,
      producer: wine.producer,
      vintage: wine.vintage,
      varietal: wine.varietal,
      region: wine.region,
      colour: wine.colour,
      hero_image_url: wine.hero_image_url,
    },
  };
}

/**
 * Append every created row to its own section. Idempotent: a row whose id is
 * already present is skipped, so a concurrent `router.refresh()` that has
 * already delivered it cannot produce a duplicate.
 */
export function withAddedItems(
  sections: WineListEditorSection[],
  created: CreatedItem[],
  request: AddWineRequest,
): WineListEditorSection[] {
  if (created.length === 0) return sections;
  return sections.map((section) => {
    const rows = created.filter(
      (row) =>
        row.sectionId === section.id &&
        !section.wine_list_items.some((item) => item.id === row.itemId),
    );
    if (rows.length === 0) return section;
    const nextPosition =
      section.wine_list_items.reduce(
        (max, item) => Math.max(max, item.position),
        -1,
      ) + 1;
    return {
      ...section,
      wine_list_items: [
        ...section.wine_list_items,
        ...rows.map((row, index) =>
          buildAddedItem(row.itemId, section.id, request, nextPosition + index),
        ),
      ],
    };
  });
}

/** Comma-joined section names, with "and" before the last one. */
export function listSectionNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the user is told after the write settles. Null when there is nothing to say. */
export function addWineMessages(
  wineName: string,
  addedNames: string[],
  failedNames: string[],
): { notice: string | null; error: string | null } {
  if (failedNames.length === 0) {
    return {
      notice:
        addedNames.length > 0
          ? `Added ${wineName} to ${listSectionNames(addedNames)}.`
          : null,
      error: null,
    };
  }
  if (addedNames.length === 0) {
    return {
      notice: null,
      error: `Couldn't add ${wineName} to ${listSectionNames(failedNames)}. Please try again.`,
    };
  }
  return {
    notice: null,
    error: `Added ${wineName} to ${listSectionNames(addedNames)}, but ${listSectionNames(failedNames)} failed. Please try again.`,
  };
}

async function postItem(
  sectionId: string,
  request: AddWineRequest,
): Promise<string | null> {
  try {
    const response = await fetch("/api/wine-list-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        section_id: sectionId,
        wine_id: request.wine.id,
        glass_price: request.glassPrice,
        bottle_price: request.bottlePrice,
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { id?: unknown };
    return typeof payload.id === "string" ? payload.id : null;
  } catch {
    return null;
  }
}

export function useAddWine({
  sections,
  setSections,
  setActiveSection,
  setNotice,
  setErrorToast,
  closeModal,
  refresh,
}: {
  sections: WineListEditorSection[];
  setSections: Dispatch<SetStateAction<WineListEditorSection[]>>;
  setActiveSection: Dispatch<SetStateAction<string>>;
  setNotice: (message: string) => void;
  setErrorToast: Dispatch<SetStateAction<string | null>>;
  closeModal: () => void;
  refresh: () => void;
}) {
  return useCallback(
    async (request: AddWineRequest) => {
      if (request.sectionIds.length === 0) return;
      setErrorToast(null);

      const outcome: AddWineOutcome = { created: [], failedSectionIds: [] };
      for (const sectionId of request.sectionIds) {
        const itemId = await postItem(sectionId, request);
        if (itemId) outcome.created.push({ sectionId, itemId });
        else outcome.failedSectionIds.push(sectionId);
      }

      const nameOf = (id: string) =>
        sections.find((section) => section.id === id)?.name ?? "this section";
      const wineName = `${request.wine.producer}, ${request.wine.name}`.replace(
        /^, /,
        "",
      );
      const { notice, error } = addWineMessages(
        wineName,
        outcome.created.map((row) => nameOf(row.sectionId)),
        outcome.failedSectionIds.map(nameOf),
      );

      if (outcome.created.length > 0) {
        setSections((previous) =>
          withAddedItems(previous, outcome.created, request),
        );
        // Cause B: the wine may have been filed into a section the user is not
        // looking at. Go there, so the result of the add is on screen.
        setActiveSection(outcome.created[0].sectionId);
      }
      if (error) setErrorToast(error);
      else closeModal();
      if (notice) setNotice(notice);
      if (outcome.created.length > 0) refresh();
    },
    [
      sections,
      setSections,
      setActiveSection,
      setNotice,
      setErrorToast,
      closeModal,
      refresh,
    ],
  );
}
