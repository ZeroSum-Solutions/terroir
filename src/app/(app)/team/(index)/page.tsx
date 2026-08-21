import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { resolveMemberIdentities } from "@/lib/team/member-identities";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { MemberAnalyticsSection } from "../member-analytics-section";
import { TeamActions } from "../team-actions";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId, restaurantName, userRole } = auth;
  // EV-7.4: member-level analytics are manager/owner-only. The roster stays
  // staff-visible (pre-existing behavior); the API route also 403s staff.
  const canViewAnalytics = userRole === "owner" || userRole === "manager";

  const [membersResult, invitationsResult] = await Promise.all([
    supabase
      .from("memberships")
      .select("id, user_id, role, created_at")
      .eq("restaurant_id", restaurantId)
      .order("created_at"),
    supabase
      .from("invitations")
      .select("id, token, role, email, expires_at, accepted_at, created_at")
      .eq("restaurant_id", restaurantId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  const { data: members, error: membersError } = membersResult;
  const { data: invitations, error: invitationsError } = invitationsResult;
  if (membersError) throw membersError;
  if (invitationsError) throw invitationsError;

  const roster = members ?? [];
  const admin = createServiceRoleClient();
  const identities = admin
    ? await resolveMemberIdentities(
        admin,
        roster.map((member) => member.user_id),
      )
    : new Map();
  const enrichedRoster = roster.map((member) => ({
    ...member,
    name: identities.get(member.user_id)?.name ?? "Team member",
    email: identities.get(member.user_id)?.email ?? "Email unavailable",
  }));
  const analyticsIdentities = Object.fromEntries(
    enrichedRoster.map((member) => [
      member.user_id,
      { name: member.name, email: member.email },
    ]),
  );

  const pendingInvitations = (invitations ?? []).map((inv) => ({
    id: inv.id,
    ...(userRole === "owner" ? { token: inv.token } : {}),
    role: inv.role as "owner" | "manager" | "staff",
    email: inv.email,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
  }));

  return (
    <section>
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-heading-sm text-ink">Team</h1>
        <p className="mt-xs text-[15px] text-grey">{restaurantName}</p>
      </header>

      <TeamActions
        members={enrichedRoster.map((m) => ({
          id: m.id,
          user_id: m.user_id,
          name: m.name,
          email: m.email,
          role: m.role as "owner" | "manager" | "staff",
          created_at: m.created_at,
        }))}
        invitations={pendingInvitations}
        currentUserId={auth.user.id}
        restaurantName={restaurantName}
        canInvite={userRole === "owner"}
      />
      {canViewAnalytics && (
        <MemberAnalyticsSection identities={analyticsIdentities} />
      )}
    </section>
  );
}
