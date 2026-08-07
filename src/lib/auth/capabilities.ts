export const MEMBERSHIP_ROLES = ["owner", "manager", "staff"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const CAPABILITIES = [
  "restaurant:view",
  "restaurant:switch",
  "restaurant:manage",
  "restaurant:delete",
  "team:view",
  "team:invite-manage",
  "team:member-manage",
  "cellar:view",
  "cellar:manage",
  "cellar:delete",
  "wine:view",
  "wine:manage",
  "wine-list:view",
  "wine-list:manage",
  "scan:create",
  "job:retry",
  "pour:record",
  "reconcile:manage",
  "insights:view",
  "export:read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL_ROLES: readonly MembershipRole[] = MEMBERSHIP_ROLES;
const MANAGERS: readonly MembershipRole[] = ["owner", "manager"];
const OWNERS: readonly MembershipRole[] = ["owner"];

/**
 * Product capability matrix shared by server routes and UI affordances.
 *
 * Database RLS remains the final authority. This map defines the intended
 * product policy so routes and interfaces do not grow independent role checks.
 */
export const CAPABILITY_ROLES = {
  "restaurant:view": ALL_ROLES,
  "restaurant:switch": ALL_ROLES,
  "restaurant:manage": OWNERS,
  "restaurant:delete": OWNERS,
  "team:view": ALL_ROLES,
  "team:invite-manage": MANAGERS,
  "team:member-manage": OWNERS,
  "cellar:view": ALL_ROLES,
  "cellar:manage": MANAGERS,
  "cellar:delete": OWNERS,
  "wine:view": ALL_ROLES,
  "wine:manage": MANAGERS,
  "wine-list:view": ALL_ROLES,
  "wine-list:manage": MANAGERS,
  "scan:create": ALL_ROLES,
  "job:retry": MANAGERS,
  "pour:record": ALL_ROLES,
  "reconcile:manage": MANAGERS,
  "insights:view": ALL_ROLES,
  "export:read": ALL_ROLES,
} as const satisfies Record<Capability, readonly MembershipRole[]>;

export function hasCapability(
  role: MembershipRole,
  capability: Capability,
): boolean {
  return (CAPABILITY_ROLES[capability] as readonly MembershipRole[]).includes(
    role,
  );
}
