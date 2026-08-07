import type { Capability } from "./capabilities";

export type ApiAuthorizationPolicy =
  | { access: "public" }
  | { access: "authenticated" }
  | { access: "membership"; capability: Capability };

type OperationId = `api:${string}:/api/${string}`;

/**
 * Authorization contract for every source-discovered API operation.
 *
 * `health` is public for platform liveness and `dev-login` is the login
 * bootstrap. Invite acceptance requires a user session but deliberately does
 * not require an existing restaurant membership. Every other operation
 * requires the named capability in the active membership.
 */
export const API_AUTHORIZATION = {
  "api:GET:/api/cellar": membership("cellar:view"),
  "api:POST:/api/cellar": membership("cellar:manage"),
  "api:PATCH:/api/cellar/{param}": membership("cellar:manage"),
  "api:DELETE:/api/cellar/{param}": membership("cellar:delete"),
  "api:PATCH:/api/cellar/{param}/section": membership("cellar:manage"),
  "api:POST:/api/cellar/batch-section": membership("cellar:manage"),
  "api:GET:/api/cellar/config": membership("cellar:view"),
  "api:POST:/api/cellar/config": membership("cellar:manage"),
  "api:PATCH:/api/cellar/config": membership("cellar:manage"),
  "api:GET:/api/cellar/grid": membership("cellar:view"),
  "api:GET:/api/dev-login": { access: "public" },
  "api:GET:/api/export/toast-csv": membership("export:read"),
  "api:GET:/api/export": membership("export:read"),
  "api:GET:/api/health": { access: "public" },
  "api:GET:/api/insights": membership("insights:view"),
  "api:GET:/api/insights/csv": membership("insights:view"),
  "api:GET:/api/insights/drink-window-alerts": membership("insights:view"),
  "api:GET:/api/insights/pour": membership("insights:view"),
  "api:GET:/api/insights/pricing-review": membership("insights:view"),
  "api:GET:/api/insights/snoozed": membership("insights:view"),
  "api:GET:/api/inventory": membership("cellar:view"),
  "api:POST:/api/inventory/save-bottle-scan": membership("scan:create"),
  "api:POST:/api/inventory/save-scan": membership("scan:create"),
  "api:POST:/api/open-bottles": membership("pour:record"),
  "api:POST:/api/open-bottles/{param}/close": membership("pour:record"),
  "api:POST:/api/pdf": membership("export:read"),
  "api:POST:/api/pour": membership("pour:record"),
  "api:POST:/api/pour/undo": membership("pour:record"),
  "api:POST:/api/reconcile": membership("reconcile:manage"),
  "api:GET:/api/restaurant": membership("restaurant:view"),
  "api:GET:/api/restaurant/{param}": membership("restaurant:view"),
  "api:PUT:/api/restaurant/{param}": membership("restaurant:switch"),
  "api:PATCH:/api/restaurant/{param}": membership("restaurant:manage"),
  "api:DELETE:/api/restaurant/{param}": membership("restaurant:delete"),
  "api:POST:/api/scan": membership("scan:create"),
  "api:POST:/api/scan-bottle": membership("scan:create"),
  "api:POST:/api/scan-bottle/confirm": membership("scan:create"),
  "api:GET:/api/scans": membership("scan:create"),
  "api:PATCH:/api/scans/{param}": membership("scan:create"),
  "api:POST:/api/scans/{param}/commit": membership("scan:create"),
  "api:GET:/api/scans/{param}/image": membership("scan:create"),
  "api:POST:/api/scans/{param}/re-extract": membership("scan:create"),
  "api:POST:/api/team/accept-invite": { access: "authenticated" },
  "api:GET:/api/team": membership("team:view"),
  "api:POST:/api/team/invite": membership("team:invite-manage"),
  "api:DELETE:/api/team/invite/{param}": membership("team:invite-manage"),
  "api:POST:/api/team/invite/{param}/resend": membership(
    "team:invite-manage",
  ),
  "api:GET:/api/team/members": membership("team:view"),
  "api:PATCH:/api/team/members/{param}": membership("team:member-manage"),
  "api:DELETE:/api/team/members/{param}": membership("team:member-manage"),
  "api:POST:/api/wine-list-items": membership("wine-list:manage"),
  "api:PATCH:/api/wine-list-items/{param}": membership("wine-list:manage"),
  "api:DELETE:/api/wine-list-items/{param}": membership("wine-list:manage"),
  "api:GET:/api/wine-list-items": membership("wine-list:view"),
  "api:PATCH:/api/wine-list-items/reorder": membership("wine-list:manage"),
  "api:POST:/api/wine-list-sections": membership("wine-list:manage"),
  "api:PATCH:/api/wine-list-sections/{param}": membership(
    "wine-list:manage",
  ),
  "api:DELETE:/api/wine-list-sections/{param}": membership(
    "wine-list:manage",
  ),
  "api:GET:/api/wine-list-sections": membership("wine-list:view"),
  "api:PATCH:/api/wine-list-sections/reorder": membership(
    "wine-list:manage",
  ),
  "api:POST:/api/wine-lists": membership("wine-list:manage"),
  "api:PATCH:/api/wine-lists/{param}": membership("wine-list:manage"),
  "api:DELETE:/api/wine-lists/{param}": membership("wine-list:manage"),
  "api:GET:/api/wine-lists": membership("wine-list:view"),
  "api:POST:/api/wine-lists/{param}/clone": membership("wine-list:manage"),
  "api:GET:/api/wine-lists/{param}/csv": membership("wine-list:view"),
  "api:POST:/api/wine-lists/{param}/publish": membership("wine-list:manage"),
  "api:DELETE:/api/wine-lists/{param}/publish":
    membership("wine-list:manage"),
  "api:PATCH:/api/wines/{param}": membership("wine:manage"),
  "api:GET:/api/wines": membership("wine:view"),
  "api:PATCH:/api/wines/{param}/availability": membership("wine:manage"),
  "api:POST:/api/wines/{param}/dismiss-pricing-alert":
    membership("wine:manage"),
  "api:POST:/api/wines/{param}/enrich": membership("wine:manage"),
  "api:POST:/api/wines/{param}/image": membership("wine:manage"),
  "api:DELETE:/api/wines/{param}/image": membership("wine:manage"),
  "api:POST:/api/wines/{param}/overpaid": membership("wine:manage"),
  "api:GET:/api/wines/{param}/pricing-suggestion": membership("wine:view"),
  "api:PATCH:/api/wines/{param}/pricing-targets": membership("wine:manage"),
  "api:POST:/api/wines/{param}/refresh-retail": membership("wine:manage"),
  "api:POST:/api/wines/{param}/snooze-alert": membership("wine:manage"),
  "api:GET:/api/wines/availability": membership("wine:view"),
  "api:POST:/api/wines/create-from-lwin": membership("wine:manage"),
  "api:POST:/api/wines/enrich": membership("wine:manage"),
  "api:GET:/api/wines/lwin-search": membership("wine:view"),
  "api:GET:/api/wines/price-comparison": membership("wine:view"),
  "api:POST:/api/wines/refresh-retail-batch": membership("wine:manage"),
  "api:GET:/api/wines/search": membership("wine:view"),
} as const satisfies Record<OperationId, ApiAuthorizationPolicy>;

function membership(capability: Capability) {
  return { access: "membership", capability } as const;
}
