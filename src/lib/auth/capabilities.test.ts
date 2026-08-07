import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_ROLES,
  hasCapability,
  type MembershipRole,
} from "./capabilities";

const roles: MembershipRole[] = ["owner", "manager", "staff"];

describe("capability matrix", () => {
  it("matches the independently specified capability sets for every role", () => {
    const expectedByRole: Record<MembershipRole, string[]> = {
      owner: [...CAPABILITIES],
      manager: [
        "restaurant:view",
        "restaurant:switch",
        "team:view",
        "team:invite-manage",
        "cellar:view",
        "cellar:manage",
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
      ],
      staff: [
        "restaurant:view",
        "restaurant:switch",
        "team:view",
        "cellar:view",
        "wine:view",
        "wine-list:view",
        "scan:create",
        "pour:record",
        "insights:view",
        "export:read",
      ],
    };

    expect(Object.keys(CAPABILITY_ROLES).sort()).toEqual(
      [...CAPABILITIES].sort(),
    );

    for (const role of roles) {
      const actual = CAPABILITIES.filter((capability) =>
        hasCapability(role, capability),
      );
      expect(actual).toEqual(expectedByRole[role]);
    }
  });

  it("keeps staff operational access read-only except scanning and pours", () => {
    expect(hasCapability("staff", "cellar:view")).toBe(true);
    expect(hasCapability("staff", "wine-list:view")).toBe(true);
    expect(hasCapability("staff", "insights:view")).toBe(true);
    expect(hasCapability("staff", "scan:create")).toBe(true);
    expect(hasCapability("staff", "pour:record")).toBe(true);

    expect(hasCapability("staff", "cellar:manage")).toBe(false);
    expect(hasCapability("staff", "wine:manage")).toBe(false);
    expect(hasCapability("staff", "wine-list:manage")).toBe(false);
    expect(hasCapability("staff", "reconcile:manage")).toBe(false);
    expect(hasCapability("staff", "restaurant:manage")).toBe(false);
    expect(hasCapability("staff", "team:invite-manage")).toBe(false);
    expect(hasCapability("staff", "team:member-manage")).toBe(false);
    expect(hasCapability("staff", "job:retry")).toBe(false);
  });

  it("keeps destructive and membership-management capabilities owner-only", () => {
    expect(CAPABILITY_ROLES["restaurant:delete"]).toEqual(["owner"]);
    expect(CAPABILITY_ROLES["cellar:delete"]).toEqual(["owner"]);
    expect(CAPABILITY_ROLES["team:member-manage"]).toEqual(["owner"]);
  });

  it("allows owner and manager to manage invitations per the council default", () => {
    expect(CAPABILITY_ROLES["team:invite-manage"]).toEqual([
      "owner",
      "manager",
    ]);
  });

  it("allows owner and manager to manage wine and list workflows", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(hasCapability(role, "cellar:manage")).toBe(true);
      expect(hasCapability(role, "wine:manage")).toBe(true);
      expect(hasCapability(role, "wine-list:manage")).toBe(true);
      expect(hasCapability(role, "reconcile:manage")).toBe(true);
      expect(hasCapability(role, "job:retry")).toBe(true);
    }
  });
});
