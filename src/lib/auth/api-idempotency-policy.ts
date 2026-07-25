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
} as const satisfies Partial<
  Record<ApiOperationId, ApiIdempotencyImplementation>
>;
