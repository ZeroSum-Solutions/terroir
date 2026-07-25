import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const editor = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(app)/lists/[id]/wine-list-editor.tsx",
  ),
  "utf8",
);

describe("wine-list section caller contract", () => {
  it("routes all four mutations through persistent guarded commands", () => {
    expect(editor).toContain("createIdempotentCommandStore");
    expect(editor).toContain("createSessionCommandPersistence");
    expect(editor).toContain("sectionMutationSlotsRef.current");
    expect(editor).toContain('url: "/api/wine-list-sections"');
    expect(editor).toContain(
      'url: "/api/wine-list-sections/reorder"',
    );
    expect(editor).toContain(
      "url: `/api/wine-list-sections/${id}`",
    );
    expect(editor).toContain(
      "url: `/api/wine-list-sections/${targetId}`",
    );
    expect(editor).not.toContain(
      'fetch("/api/wine-list-sections", {',
    );
    expect(editor).not.toContain(
      'fetch("/api/wine-list-sections/reorder", {',
    );
    expect(editor).not.toContain(
      "fetch(`/api/wine-list-sections/${id}`, {",
    );
  });
});
