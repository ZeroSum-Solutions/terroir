import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

describe("/api/pdf architecture boundary", () => {
  it("keeps PDF rendering and wine-list shaping out of the route handler", () => {
    expect(routeSource).toContain(
      "@/domains/wine-lists/wine-list-pdf-service",
    );
    expect(routeSource).not.toContain("puppeteer");
    expect(routeSource).not.toMatch(/@\/lib\/wine-list\/(?:render|templates|shapes)/);
    expect(routeSource).not.toContain("@sentry/nextjs");
  });
});

