export type MemberRole = "owner" | "manager" | "staff";

export type ResolvedMemberIdentity = {
  userId: string;
  name: string;
  email: string;
};

type AdminUser = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

type AdminClient = {
  auth: {
    admin: {
      getUserById: (userId: string) => Promise<{
        data: { user: AdminUser | null };
        error: unknown;
      }>;
    };
  };
};

export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: "Full access, including team access.",
  manager: "Manage inventory and wine lists, publish menus, and reconcile.",
  staff: "Scan invoices, record pours, and view restaurant data.",
};

export async function resolveMemberIdentities(
  admin: AdminClient,
  userIds: readonly string[],
): Promise<Map<string, ResolvedMemberIdentity>> {
  const pairs = await Promise.all(
    [...new Set(userIds)].map(async (userId) => {
      let user: AdminUser | null = null;
      try {
        const { data, error } = await admin.auth.admin.getUserById(userId);
        user = error ? null : data.user;
      } catch {
        // One unavailable auth user must not prevent the rest of the roster.
      }

      return [
        userId,
        {
          userId,
          name: displayName(user?.user_metadata, user?.email),
          email: user?.email?.trim() || "Email unavailable",
        },
      ] as const;
    }),
  );

  return new Map(pairs);
}

function displayName(
  metadata: Record<string, unknown> | null | undefined,
  email: string | null | undefined,
): string {
  const fullName = stringMetadata(metadata?.full_name);
  if (fullName) return fullName;

  const name = stringMetadata(metadata?.name);
  if (name) return name;

  const emailName = email?.split("@", 1)[0]?.trim();
  if (!emailName) return "Team member";

  const words = emailName
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return words || "Team member";
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
