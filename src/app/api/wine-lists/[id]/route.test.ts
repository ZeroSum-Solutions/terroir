import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("wine-lists [id] route auth guards", () => {
  const routeContent = readFileSync(
    join(__dirname, "route.ts"),
    "utf-8",
  );

  it("uses requireMembership, not requireAuth", () => {
    expect(routeContent).toContain("requireMembership");
    expect(routeContent).not.toMatch(/requireAuth[^C]/);
  });
});
