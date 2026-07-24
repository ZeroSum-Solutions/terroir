import type { ApiOperationId } from "./api-abuse-policy";

export type ApiIdempotencyImplementation = {
  boundary:
    | { kind: "generic-wrapper"; count: number }
    | { kind: "dedicated-rpc"; rpc: string };
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
