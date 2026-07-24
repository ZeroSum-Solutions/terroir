import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("high-risk idempotency clients", () => {
  it("keeps one open-bottle key across remounts and transient failures", () => {
    const drawer = source(
      "src/app/(app)/cellar/wine-detail-drawer.tsx",
    );

    expect(drawer).toContain(
      "openBottleCommandRef.current?.wineId !== row.wine_id",
    );
    expect(drawer).toContain('"Idempotency-Key": commandKey');
    expect(drawer).toContain("shouldRetainIdempotencyKey(");
    expect(drawer).toContain("terroir:open-bottle:");
    expect(drawer).toContain("sessionStorage.setItem(");
    expect(drawer).toMatch(
      /if \(!res\.ok\)[\s\S]*?shouldRetainIdempotencyKey[\s\S]*?openBottleCommandRef\.current = null/,
    );
  });

  it("persists one invitation key across remounts and transient failures", () => {
    const invitePage = source("src/app/invite/[token]/page.tsx");

    expect(invitePage).toContain("terroir:invite-acceptance");
    expect(invitePage).toContain('"Idempotency-Key": command.key');
    expect(invitePage).toContain("shouldRetainIdempotencyKey(");
    expect(invitePage).toContain("sessionStorage.setItem(");
    expect(invitePage).toContain('canRetry ? "Try again" : "Go to login"');
  });
});
