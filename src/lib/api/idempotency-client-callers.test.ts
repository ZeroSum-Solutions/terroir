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

  it("closes one exact bottle generation with a persistent guarded slot", () => {
    const closeButton = source(
      "src/app/(app)/cellar/open/close-button.tsx",
    );
    const openPage = source(
      "src/app/(app)/cellar/open/page.tsx",
    );

    expect(closeButton).toContain("createIdempotentCommandStore");
    expect(closeButton).toContain(
      'createSessionCommandPersistence("terroir:close-bottle")',
    );
    expect(closeButton).toContain("slot: `close:${bottleId}`");
    expect(closeButton).toContain(
      "url: `/api/open-bottles/${bottleId}/close`",
    );
    expect(closeButton).toContain(
      "expected_opened_at: normalizeIsoUtcTimestamp(openedAt)",
    );
    expect(closeButton).toContain("if (closingRef.current) return");
    expect(openPage.match(/openedAt=\{bottle\.opened_at\}/g)).toHaveLength(
      2,
    );
  });

  it("persists pour keys and reconciles outcome-ambiguous failures", () => {
    const drawer = source(
      "src/app/(app)/cellar/wine-detail-drawer.tsx",
    );

    expect(drawer).toContain(
      'createSessionCommandPersistence("terroir:pour")',
    );
    expect(drawer.indexOf("const pourCommands")).toBeLessThan(
      drawer.indexOf("export function WineDetailDrawer"),
    );
    expect(drawer).toContain("slot: `pour:${row.wine_id}`");
    expect(drawer).toContain('url: "/api/pour"');
    expect(drawer).toContain(
      "pourBusyRef.current ||\n        undoBusyRef.current",
    );
    expect(drawer).toContain("pourBusyRef.current = true");
    expect(drawer).toContain("shouldRetainIdempotencyKey(");
    expect(drawer).toContain("if (shouldReconcile)");
    expect(drawer).not.toContain('fetch("/api/pour"');
  });

  it("keeps one pour-undo key across remounts and reconciles ambiguity", () => {
    const drawer = source(
      "src/app/(app)/cellar/wine-detail-drawer.tsx",
    );

    expect(drawer).toContain(
      'createSessionCommandPersistence("terroir:pour-undo")',
    );
    expect(drawer).toContain("slot: `undo:${row.wine_id}`");
    expect(drawer).toContain('url: "/api/pour/undo"');
    expect(drawer).toContain(
      "if (!row || !lastPour || undoBusyRef.current) return",
    );
    expect(drawer).toContain(
      "pourBusyRef.current ||\n        undoBusyRef.current",
    );
    expect(drawer).toContain(
      "abandonUndoPourSlot(`undo:${row.wine_id}`)",
    );
    expect(drawer).toContain(
      "flushPendingUndoPourSlotReset(`undo:${row.wine_id}`)",
    );
    expect(drawer).toContain("undoBusyRef.current = true");
    expect(drawer).toContain("shouldRetainIdempotencyKey(");
    expect(drawer).toContain("readApiErrorCode(data)");
    expect(drawer).toContain("const isAlreadyUndone =");
    expect(drawer).toContain("if (isAlreadyUndone) setLastPour(null)");
    expect(drawer).toContain("if (shouldReconcile)");
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

  it("persists guarded per-member role and removal command slots", () => {
    const teamActions = source(
      "src/app/(app)/team/team-actions.tsx",
    );

    expect(teamActions).toContain("createIdempotentCommandStore");
    expect(teamActions).toContain(
      'createSessionCommandPersistence("terroir:team-members")',
    );
    expect(teamActions.indexOf("const teamMemberCommands")).toBeLessThan(
      teamActions.indexOf("export function TeamActions"),
    );
    expect(teamActions).toContain(
      "if (busyMemberIdsRef.current.has(memberId)) return",
    );
    expect(teamActions).toContain(
      "slot: `team:member:role:${memberId}`",
    );
    expect(teamActions).toContain(
      "slot: `team:member:remove:${memberId}`",
    );
    expect(teamActions).toContain(
      "url: `/api/team/members/${memberId}`",
    );
    expect(teamActions).toContain("disabled={memberBusy}");
    expect(teamActions).toContain("readApiError(");
    expect(teamActions.match(/response\.json\(/g)).toBeNull();
  });

  it("keeps restaurant onboarding name retries in one guarded field slot", () => {
    const onboarding = source("src/app/(app)/onboarding-modal.tsx");

    expect(onboarding).toContain("createIdempotentCommandStore");
    expect(onboarding).toContain("if (savingRef.current) return");
    expect(onboarding).toContain("savingRef.current = true");
    expect(onboarding).toContain(
      "slot: `restaurant:${restaurantId}:name`",
    );
    expect(onboarding).toContain(
      "url: `/api/restaurant/${restaurantId}`",
    );
    expect(onboarding).toContain("readApiError(");
  });

  it("uses guarded per-field slots for restaurant auto-86 settings", () => {
    const autoEightysix = source(
      "src/app/(app)/cellar/auto-eightysix-panel.tsx",
    );

    expect(autoEightysix).toContain("createIdempotentCommandStore");
    expect(autoEightysix.match(/if \(savingRef\.current\) return/g)).toHaveLength(
      3,
    );
    expect(autoEightysix).toContain(
      "`restaurant:${restaurantId}:auto_eightysix_from_inventory`",
    );
    expect(autoEightysix).toContain(
      "`restaurant:${restaurantId}:eightysix_ml_threshold`",
    );
    expect(autoEightysix).toContain(
      "`restaurant:${restaurantId}:eightysix_strategy`",
    );
    expect(autoEightysix).toContain("readApiError(");
    expect(autoEightysix).toContain("setEnabled(initialEnabled)");
    expect(autoEightysix).toContain("setThresholdMl(initialThreshold)");
    expect(autoEightysix).toContain(
      "setEightysixStrategy(initialStrategy)",
    );
    expect(autoEightysix.match(/router\.refresh\(\)/g)).toHaveLength(2);
  });

  it("uses guarded per-field slots for restaurant pricing targets", () => {
    const pricing = source(
      "src/app/(app)/cellar/pricing-targets-panel.tsx",
    );

    expect(pricing).toContain("createIdempotentCommandStore");
    expect(pricing.match(/if \(savingRef\.current\) return/g)).toHaveLength(2);
    expect(pricing).toContain(
      "`restaurant:${restaurantId}:default_target_pour_cost_pct`",
    );
    expect(pricing).toContain(
      "`restaurant:${restaurantId}:default_target_markup_ratio`",
    );
    expect(pricing).toContain("readApiError(");
    expect(pricing).toContain(
      "initialPourCost ?? DEFAULT_TARGET_POUR_COST_PCT",
    );
    expect(pricing).toContain(
      "initialMarkup ?? DEFAULT_TARGET_MARKUP_RATIO",
    );
    expect(pricing.match(/router\.refresh\(\)/g)).toHaveLength(2);
  });

  it("guards cellar section retries with per-wine and bulk command slots", () => {
    const cellarList = source(
      "src/app/(app)/cellar/cellar-list.tsx",
    );
    const batchHelper = source("src/lib/cellar/batch-section.ts");

    expect(
      cellarList.match(/createIdempotentCommandStore\(\)/g),
    ).toHaveLength(1);
    expect(cellarList).toContain(
      "if (movingWineIdsRef.current.has(wineId)) return",
    );
    expect(cellarList).toContain(
      "movingWineIdsRef.current.add(wineId)",
    );
    expect(cellarList).toContain(
      "movingWineIdsRef.current.size > 0",
    );
    expect(cellarList).toContain("disabled: !assignable || moving");
    expect(cellarList).toContain("if (bulkBusyRef.current)");
    expect(cellarList).toContain("bulkBusyRef.current = true");
    expect(cellarList).toMatch(
      /new Set\(\s*selectedWineIds\.slice\(assignedCount\),?\s*\)/,
    );
    expect(cellarList).toContain("commands,");

    expect(batchHelper).toContain(
      "slot: `cellar:section:${input.wineId}`",
    );
    expect(batchHelper).toContain(
      "const section = normalizeCellarSection(input.section)",
    );
    expect(batchHelper).toContain(
      "return `cellar:batch-section:${firstId}:${lastId}:${wineIds.length}`",
    );
    expect(batchHelper).toContain(
      'url: "/api/cellar/batch-section"',
    );
    expect(batchHelper).toContain("wine_ids: wineIds");
    expect(batchHelper).toContain(
      "candidate.updated === expectedUpdated",
    );
    expect(batchHelper.match(/response\.json\(/g)).toBeNull();
  });

  it("persists one guarded ordered reconcile batch across ambiguous failures", () => {
    const reconcile = source(
      "src/app/(app)/cellar/reconcile-list.tsx",
    );

    expect(reconcile).toContain("createIdempotentCommandStore");
    expect(reconcile).toContain(
      'createSessionCommandPersistence("terroir:reconcile")',
    );
    expect(reconcile).toContain("if (changedCount === 0 || savingRef.current) return");
    expect(reconcile).toContain("savingRef.current = true");
    expect(reconcile).toContain('slot: "save-all"');
    expect(reconcile).toContain('url: "/api/reconcile"');
    expect(reconcile).toContain("disabled={saving}");
    expect(reconcile).toContain("readApiError(");
  });

  it("persists guarded cellar creation and reconciles ambiguous outcomes", () => {
    const grid = source(
      "src/app/(app)/cellar/cellar-grid.tsx",
    );

    expect(grid).toContain("createIdempotentCommandStore");
    expect(grid).toContain(
      '"terroir:cellar-config:create"',
    );
    expect(grid.indexOf("const createCellarCommands")).toBeLessThan(
      grid.indexOf("export function CellarSetup"),
    );
    expect(grid).toContain("if (creatingRef.current) return");
    expect(grid).toContain("creatingRef.current = true");
    expect(grid).toContain('slot: "cellar-config:create"');
    expect(grid).toContain('url: "/api/cellar/config"');
    expect(grid).toContain('method: "POST"');
    expect(grid).toContain("shouldRetainIdempotencyKey(");
    expect(grid).toContain("reconcileCellarGrid(");
    expect(grid).toContain("readApiError(");
  });

  it("persists guarded section-config edits without clearing unsent input", () => {
    const page = source(
      "src/app/(app)/cellar/config/page.tsx",
    );

    expect(page).toContain("createIdempotentCommandStore");
    expect(page).toContain(
      '"terroir:cellar-config:sections"',
    );
    expect(page.indexOf("const cellarConfigCommands")).toBeLessThan(
      page.indexOf("export default function CellarConfigPage"),
    );
    expect(page).toContain(
      "if (busyRef.current || !configurationReadable) return false",
    );
    expect(page).toContain("busyRef.current = true");
    expect(page).toContain('slot: "cellar-config:sections"');
    expect(page).toContain('url: "/api/cellar/config"');
    expect(page).toContain('method: "PATCH"');
    expect(page).toContain("shouldRetainIdempotencyKey(");
    expect(page).toContain("reconcileSections(");
    expect(page).toContain("readApiError(");
    expect(page).toContain("setSections(reordered)");
    expect(page).toContain("if (!saved) setSections(sections)");
    expect(page).toContain("if (saved) {");
    expect(page).toContain('setNewName("")');
  });
});
