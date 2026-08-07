import type { ApiOperationId } from "./api-abuse-policy";

export type ApiIdempotencyImplementation = {
  boundary:
    | { kind: "generic-wrapper"; count: number }
    | { kind: "dedicated-rpc"; rpc: string; source?: string };
  identity: {
    params: "none" | "all-validated";
    body: "none" | "all-validated";
    binary: "none" | "optional" | "required";
  };
  execution:
    | { kind: "atomic-rpc"; rpc: string }
    | { kind: "fail-closed"; releaseOnError: false };
  client: {
    lifecycle:
      | "retry-stable"
      | "session-persistent"
      | "no-first-party-caller";
    sources: readonly string[];
  };
};

/**
 * Truthful implementation ledger for TER-020D.
 *
 * API_ABUSE_POLICY declares which operations must support idempotency. This
 * map records only operations whose route boundary and truthful implementation
 * metadata have landed. Pending operations stay absent until their full
 * route-and-caller leaf is green; the contract test keeps the exact pending
 * queue explicit and mechanically verifies the reachable boundary, canonical
 * hash call, binary mode, and caller evidence.
 */
export const API_IDEMPOTENCY_IMPLEMENTATIONS = {
  "api:DELETE:/api/cellar/{param}": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "delete_cellar_wine_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "delete_cellar_wine_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/cellar/wine-detail-drawer.tsx"],
    },
  },
  "api:DELETE:/api/team/invite/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/team/team-actions.tsx"],
    },
  },
  "api:PATCH:/api/cellar/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "no-first-party-caller",
      sources: [],
    },
  },
  "api:PATCH:/api/cellar/{param}/section": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "retry-stable",
      sources: [
        "src/app/(app)/cellar/cellar-list.tsx",
        "src/lib/cellar/batch-section.ts",
      ],
    },
  },
  "api:POST:/api/cellar": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "add_cellar_wine_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "add_cellar_wine_idempotent",
    },
    client: {
      lifecycle: "no-first-party-caller",
      sources: [],
    },
  },
  "api:PATCH:/api/cellar/config": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/cellar/config/page.tsx"],
    },
  },
  "api:POST:/api/cellar/batch-section": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "assign_cellar_section_batch",
    },
    client: {
      lifecycle: "retry-stable",
      sources: ["src/lib/cellar/batch-section.ts"],
    },
  },
  "api:POST:/api/cellar/config": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/cellar/cellar-grid.tsx"],
    },
  },
  "api:PATCH:/api/restaurant/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "retry-stable",
      sources: [
        "src/app/(app)/onboarding-modal.tsx",
        "src/app/(app)/cellar/auto-eightysix-panel.tsx",
        "src/app/(app)/cellar/pricing-targets-panel.tsx",
      ],
    },
  },
  "api:PUT:/api/restaurant/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/settings-dropdown.tsx"],
    },
  },
  "api:DELETE:/api/restaurant/{param}": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "delete_restaurant_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "delete_restaurant_idempotent",
    },
    client: {
      lifecycle: "no-first-party-caller",
      sources: [],
    },
  },
  "api:POST:/api/inventory/save-bottle-scan": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "retry-stable",
      sources: ["src/app/(app)/scan/scanner.tsx"],
    },
  },
  "api:POST:/api/inventory/save-scan": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "optional",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "retry-stable",
      sources: ["src/app/(app)/scan/scanner.tsx"],
    },
  },
  "api:POST:/api/open-bottles": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "open_bottle_from_inventory_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "open_bottle_from_inventory_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/cellar/wine-detail-drawer.tsx",
      ],
    },
  },
  "api:POST:/api/open-bottles/{param}/close": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "close_open_bottle_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "close_open_bottle_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/cellar/open/close-button.tsx"],
    },
  },
  "api:POST:/api/pour": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "record_pour_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "record_pour_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/cellar/wine-detail-drawer.tsx",
      ],
    },
  },
  "api:POST:/api/pour/undo": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "undo_last_pour_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "undo_last_pour_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/cellar/wine-detail-drawer.tsx",
      ],
    },
  },
  "api:POST:/api/reconcile": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "reconcile_open_bottles_idempotent",
      source: "src/domains/cellar/reconcile-service.ts",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "reconcile_open_bottles_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/cellar/reconcile-list.tsx",
      ],
    },
  },
  "api:POST:/api/scan-bottle": {
    boundary: { kind: "generic-wrapper", count: 2 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "optional",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/scan-bottle/page.tsx",
        "src/app/(app)/scan/scanner.tsx",
      ],
    },
  },
  "api:POST:/api/scan-bottle/confirm": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "confirm_bottle_scan_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "confirm_bottle_scan_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/scan-bottle/page.tsx"],
    },
  },
  "api:POST:/api/scan": {
    boundary: { kind: "generic-wrapper", count: 2 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "optional",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "retry-stable",
      sources: ["src/app/(app)/scan/scanner.tsx"],
    },
  },
  "api:PATCH:/api/scans/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/scan/components/scan-review.tsx"],
    },
  },
  "api:POST:/api/scans/{param}/commit": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "commit_invoice_scan_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "commit_invoice_scan_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/scan/components/scan-review.tsx"],
    },
  },
  "api:POST:/api/scans/{param}/re-extract": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/scan/[id]/components/re-extract-button.tsx",
      ],
    },
  },
  "api:POST:/api/team/accept-invite": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "accept_invitation_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "accept_invitation_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/invite/[token]/page.tsx"],
    },
  },
  "api:PATCH:/api/team/members/{param}": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "update_team_member_role_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "update_team_member_role_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/team/team-actions.tsx"],
    },
  },
  "api:POST:/api/team/invite": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/team/team-actions.tsx"],
    },
  },
  "api:DELETE:/api/team/members/{param}": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "remove_team_member_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "remove_team_member_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/team/team-actions.tsx"],
    },
  },
  "api:POST:/api/team/invite/{param}/resend": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/team/team-actions.tsx"],
    },
  },
  "api:DELETE:/api/wine-list-items/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:PATCH:/api/wine-list-items/reorder": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "reorder_wine_list_items",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:PATCH:/api/wine-list-items/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:POST:/api/wine-list-items": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "create_wine_list_item_idempotent",
    },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "create_wine_list_item_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:DELETE:/api/wine-list-sections/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:PATCH:/api/wine-list-sections/reorder": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "reorder_wine_list_sections",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:PATCH:/api/wine-list-sections/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:POST:/api/wine-list-sections": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "create_wine_list_section",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/[id]/wine-list-editor.tsx"],
    },
  },
  "api:DELETE:/api/wine-lists/{param}/publish": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "set_wine_list_publication_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "set_wine_list_publication_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/lists/[id]/components/publish-modal.tsx",
      ],
    },
  },
  "api:DELETE:/api/wine-lists/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/wine-list-landing.tsx"],
    },
  },
  "api:POST:/api/wine-lists/{param}/clone": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "clone_wine_list_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "clone_wine_list_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/wine-list-landing.tsx"],
    },
  },
  "api:POST:/api/wine-lists/{param}/publish": {
    boundary: {
      kind: "dedicated-rpc",
      rpc: "set_wine_list_publication_idempotent",
    },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: {
      kind: "atomic-rpc",
      rpc: "set_wine_list_publication_idempotent",
    },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/lists/[id]/components/publish-modal.tsx",
      ],
    },
  },
  "api:PATCH:/api/wine-lists/{param}": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/lists/wine-list-landing.tsx",
        "src/app/(app)/lists/[id]/wine-list-editor.tsx",
        "src/app/(app)/lists/[id]/components/publish-modal.tsx",
      ],
    },
  },
  "api:POST:/api/wine-lists": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "none",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/app/(app)/lists/wine-list-landing.tsx"],
    },
  },
  "api:PATCH:/api/wines/{param}/pricing-targets": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/cellar/pricing-target-override.tsx",
      ],
    },
  },
  "api:POST:/api/wines/{param}/dismiss-pricing-alert": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/insights/pricing-review-card.tsx",
        "src/app/(app)/insights/snoozed-alerts-card.tsx",
      ],
    },
  },
  "api:POST:/api/wines/{param}/overpaid": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "none",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: ["src/components/overpaid-flag-button.tsx"],
    },
  },
  "api:POST:/api/wines/{param}/snooze-alert": {
    boundary: { kind: "generic-wrapper", count: 1 },
    identity: {
      params: "all-validated",
      body: "all-validated",
      binary: "none",
    },
    execution: { kind: "fail-closed", releaseOnError: false },
    client: {
      lifecycle: "session-persistent",
      sources: [
        "src/app/(app)/insights/briefing-alert-card.tsx",
        "src/app/(app)/insights/snoozed-alerts-card.tsx",
      ],
    },
  },
} as const satisfies Partial<
  Record<ApiOperationId, ApiIdempotencyImplementation>
>;
