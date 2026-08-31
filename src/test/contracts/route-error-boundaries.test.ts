import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A server component that rethrows a failed query has to fail INSIDE the app
 * shell. With no `error.tsx` at its segment or any ancestor of it, the throw
 * reaches `src/app/global-error.tsx`, which renders its own <html>/<body> and
 * so replaces the whole page — nav, header, tab bar and all — for what may be
 * one transient database error on one panel.
 *
 * Five routes that rethrow (atlas, bins, cellar, cellar/[wineId], insights)
 * had no boundary. This is the rule they were missing, written down: every
 * server page under (app) that can throw is covered by a boundary.
 *
 * The converse is deliberately NOT asserted. A route that swallows its query
 * errors, or turns them into notFound(), cannot reach a boundary, and adding
 * an error.tsx there would be a file that never renders.
 */
const appRoot = path.join(process.cwd(), "src/app/(app)");

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(entryPath);
    return entry.name === "page.tsx" ? [entryPath] : [];
  });
}

/** The nearest error.tsx at or above `directory`, stopping at (app). */
function coveringBoundary(directory: string): string | null {
  let current = directory;
  for (;;) {
    const candidate = path.join(current, "error.tsx");
    if (existsSync(candidate)) return path.relative(process.cwd(), candidate);
    if (current === appRoot) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

describe("route error-boundary contract", () => {
  const pages = pageFiles(appRoot);

  it("finds the app routes to check", () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it("covers every server page that rethrows with an error boundary", () => {
    const uncovered = pages.filter((file) => {
      const source = readFileSync(file, "utf8");
      if (source.startsWith('"use client"')) return false;
      if (!/\bthrow\b/.test(source)) return false;
      return coveringBoundary(path.dirname(file)) === null;
    });

    expect(
      uncovered.map((file) => path.relative(process.cwd(), file)),
      "these pages rethrow a failed query with nothing but global-error.tsx to catch it, which blanks the whole shell",
    ).toEqual([]);
  });

  it("keeps global-error.tsx as the last resort, not the first", () => {
    // If this ever grows to cover most of (app), the boundaries above have
    // stopped doing their job.
    expect(existsSync(path.join(process.cwd(), "src/app/global-error.tsx"))).toBe(
      true,
    );
  });
});
