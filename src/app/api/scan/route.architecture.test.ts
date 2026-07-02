import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

describe("/api/scan architecture boundary", () => {
  it("keeps provider and scan-domain work out of the route handler", () => {
    expect(routeSource).toContain("@/domains/scanning/invoice-scan-service");
    expect(routeSource).not.toMatch(
      /@\/lib\/scanner\/(?:ai-extract|ocr-service|scoring)/,
    );
    expect(routeSource).not.toContain("@sentry/nextjs");
  });
});

