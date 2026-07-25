import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "route.ts"),
  "utf8",
);

describe("/api/pour architecture boundary", () => {
  it("uses the dedicated atomic RPC without generic idempotency transitions", () => {
    expect(routeSource).toContain("@/domains/pours/pour-service");
    expect(routeSource).toContain('"record_pour_idempotent"');
    expect(routeSource).toContain("p_idempotency_key");
    expect(routeSource).toContain("p_request_hash");
    expect(routeSource).toContain("createIdempotencyRequestHash");
    expect(routeSource).not.toContain('"record_pour"');
    expect(routeSource).not.toContain("withIdempotency");
    expect(routeSource).not.toContain("next/cache");
    expect(routeSource).not.toContain("revalidateAutoEightysixedWines");
  });
});
