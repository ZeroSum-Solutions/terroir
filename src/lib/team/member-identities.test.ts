import { describe, expect, it, vi } from "vitest";
import {
  ROLE_DESCRIPTIONS,
  resolveMemberIdentities,
} from "./member-identities";

type AuthUser = {
  email?: string;
  user_metadata: Record<string, unknown>;
};

function adminWithUsers(users: Record<string, AuthUser>) {
  return {
    auth: {
      admin: {
        getUserById: vi.fn(async (userId: string) => ({
          data: { user: users[userId] ?? null },
          error: users[userId] ? null : new Error("User not found"),
        })),
      },
    },
  };
}

describe("resolveMemberIdentities", () => {
  it("uses recognizable metadata and email without returning a UUID as identity", async () => {
    const admin = adminWithUsers({
      "u-1": {
        email: "maria.santos@example.com",
        user_metadata: { full_name: "Maria Santos" },
      },
      "u-2": {
        email: "lee.chen@example.com",
        user_metadata: {},
      },
    });

    const result = await resolveMemberIdentities(admin, [
      "u-1",
      "u-2",
      "missing-uuid",
    ]);

    expect(result.get("u-1")).toEqual({
      userId: "u-1",
      name: "Maria Santos",
      email: "maria.santos@example.com",
    });
    expect(result.get("u-2")?.name).toBe("Lee Chen");
    expect(result.get("missing-uuid")).toEqual({
      userId: "missing-uuid",
      name: "Team member",
      email: "Email unavailable",
    });
    expect([...result.values()].map((entry) => entry.name)).not.toContain(
      "missing-uuid",
    );
  });

  it("prefers name metadata and deduplicates lookups", async () => {
    const admin = adminWithUsers({
      "u-1": {
        email: "fallback@example.com",
        user_metadata: { full_name: " ", name: "Preferred Name" },
      },
    });

    const result = await resolveMemberIdentities(admin, ["u-1", "u-1"]);

    expect(result.get("u-1")?.name).toBe("Preferred Name");
    expect(admin.auth.admin.getUserById).toHaveBeenCalledOnce();
  });

  it("isolates a thrown lookup and preserves the rest of the roster", async () => {
    const getUserById = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          user: {
            email: "maria@example.com",
            user_metadata: { full_name: "Maria Santos" },
          },
        },
        error: null,
      })
      .mockRejectedValueOnce(new Error("Auth lookup failed"));
    const admin = { auth: { admin: { getUserById } } };

    const result = await resolveMemberIdentities(admin, ["u-1", "u-2"]);

    expect(result.get("u-1")?.name).toBe("Maria Santos");
    expect(result.get("u-2")).toEqual({
      userId: "u-2",
      name: "Team member",
      email: "Email unavailable",
    });
  });
});

describe("ROLE_DESCRIPTIONS", () => {
  it("keeps role copy aligned to the audited distinction matrix", () => {
    expect(ROLE_DESCRIPTIONS).toEqual({
      owner: "Full access, including team access.",
      manager: "Manage inventory and wine lists, publish menus, and reconcile.",
      staff: "Scan invoices, record pours, and view restaurant data.",
    });
  });
});
