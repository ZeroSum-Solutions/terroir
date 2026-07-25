import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("wine-list item caller contract", () => {
  it("routes all four item mutations through a persistent command store", () => {
    const editor = source(
      "src/app/(app)/lists/[id]/wine-list-editor.tsx",
    );
    const modal = source(
      "src/app/(app)/lists/[id]/components/add-wine-modal.tsx",
    );

    expect(editor).toContain("createIdempotentCommandStore");
    expect(editor).toContain("createSessionCommandPersistence");
    expect(editor).toContain("itemMutationSlotsRef.current");
    expect(editor).toContain('url: "/api/wine-list-items"');
    expect(editor).toContain(
      'url: "/api/wine-list-items/reorder"',
    );
    expect(editor).toContain(
      "url: `/api/wine-list-items/${itemId}`",
    );
    expect(editor).not.toContain(
      'fetch("/api/wine-list-items", {',
    );
    expect(editor).not.toContain(
      'fetch("/api/wine-list-items/reorder", {',
    );
    expect(editor).not.toContain(
      "fetch(`/api/wine-list-items/${itemId}`, {",
    );
    expect(modal).toContain("addingRef.current");
    expect(modal).toContain("failedSectionIds");
  });
});
