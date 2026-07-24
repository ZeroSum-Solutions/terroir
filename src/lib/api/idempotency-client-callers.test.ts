import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("high-risk idempotency clients", () => {
  it("binds scanner commands to canonical JSON or exact binary bytes", () => {
    const scanner = source("src/app/(app)/scan/scanner.tsx");

    expect(scanner).toContain("createIdempotentCommandStore");
    expect(scanner).toContain("createBinaryCommandFingerprint");
    expect(scanner).toContain('url: "/api/scan"');
    expect(scanner).toContain('url: "/api/inventory/save-scan"');
    expect(scanner).toContain(
      'url: "/api/inventory/save-bottle-scan"',
    );
    expect(scanner).not.toContain("saveKeyRef");
    expect(scanner).not.toContain("bottleSaveKeyRef");
    expect(scanner).not.toContain("scanKeyRef");
    expect(scanner).toContain("if (!scan || savingRef.current) return");
    expect(scanner).toContain("savingRef.current = true");
  });

  it("keeps one open-bottle key across remounts and transient failures", () => {
    const drawer = source(
      "src/app/(app)/cellar/wine-detail-drawer.tsx",
    );

    expect(drawer).toContain("createIdempotentCommandStore");
    expect(drawer).toContain(
      'createSessionCommandPersistence(\n        "terroir:open-bottle"',
    );
    expect(drawer).toContain("slot: `open:${row.wine_id}`");
    expect(drawer).toContain('url: "/api/open-bottles"');
    expect(drawer).toContain(
      "if (!row || openBottleBusyRef.current) return",
    );
  });

  it("persists one invitation key across remounts and transient failures", () => {
    const invitePage = source("src/app/invite/[token]/page.tsx");

    expect(invitePage).toContain("createIdempotentCommandStore");
    expect(invitePage).toContain(
      'createSessionCommandPersistence(\n        "terroir:invite-acceptance"',
    );
    expect(invitePage).toContain('slot: "accept"');
    expect(invitePage).toContain('url: "/api/team/accept-invite"');
    expect(invitePage).toContain('canRetry ? "Try again" : "Go to login"');
  });
});
