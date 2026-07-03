import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

describe("/api/wines/[id]/image architecture boundary", () => {
  it("keeps storage and wine persistence orchestration out of the route", () => {
    expect(routeSource).toContain("@/domains/cellar/wine-image-service");
    expect(routeSource).not.toContain("@sentry/nextjs");
    expect(routeSource).not.toContain(".storage");
    expect(routeSource).not.toContain(".from(");
    expect(routeSource).not.toContain("Buffer.from");
    expect(routeSource).not.toContain("MAX_BYTES");
  });
});
