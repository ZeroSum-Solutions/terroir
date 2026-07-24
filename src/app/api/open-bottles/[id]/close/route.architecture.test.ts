import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

describe("/api/open-bottles/[id]/close architecture boundary", () => {
  it("uses one dedicated idempotent RPC without the generic wrapper", () => {
    expect(routeSource).toContain("close_open_bottle_idempotent");
    expect(routeSource).toContain("p_idempotency_key");
    expect(routeSource).toContain("p_request_hash");
    expect(routeSource).toContain("createIdempotencyRequestHash");
    expect(routeSource).not.toContain("withIdempotency");
    expect(routeSource).not.toContain("@/domains/pours/pour-service");
  });
});
