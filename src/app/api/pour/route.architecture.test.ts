import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

describe("/api/pour architecture boundary", () => {
  it("keeps transactional RPC and revalidation orchestration out of the route", () => {
    expect(routeSource).toContain("@/domains/pours/pour-service");
    expect(routeSource).not.toContain("@sentry/nextjs");
    expect(routeSource).not.toContain("next/cache");
    expect(routeSource).not.toContain("revalidateAutoEightysixedWines");
    expect(routeSource).not.toContain(".rpc(");
  });
});

