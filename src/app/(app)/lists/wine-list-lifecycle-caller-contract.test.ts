import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("wine-list lifecycle caller contract", () => {
  it("routes every first-party create, update, and delete through command stores", () => {
    const landing = source(
      "src/app/(app)/lists/wine-list-landing.tsx",
    );
    const editor = source(
      "src/app/(app)/lists/[id]/wine-list-editor.tsx",
    );
    const publishModal = source(
      "src/app/(app)/lists/[id]/components/publish-modal.tsx",
    );

    for (const caller of [landing, editor, publishModal]) {
      expect(caller).toContain("createIdempotentCommandStore");
      expect(caller).toContain("createSessionCommandPersistence");
    }

    expect(landing).not.toContain(
      'fetch(`/api/wine-lists/${list.id}`, {',
    );
    expect(landing).not.toContain(
      'fetch(`/api/wine-lists/${list.id}/clone`, {',
    );
    expect(landing).not.toContain('fetch("/api/wine-lists", {');
    expect(editor).not.toContain(
      'fetch(`/api/wine-lists/${list.id}`, {',
    );
    expect(publishModal).not.toContain(
      'fetch(`/api/wine-lists/${listId}`, {',
    );
    expect(publishModal).not.toContain(
      'fetch(`/api/wine-lists/${listId}/publish`, {',
    );
    expect(editor).toContain("templateMutationRef.current");
    expect(publishModal).toContain("slugMutationRef.current");
    expect(publishModal).toContain("publicationMutationRef.current");
    expect(landing).toContain("creatingRef.current");
    expect(landing).toContain("activeMutationSlotsRef.current");
  });
});
