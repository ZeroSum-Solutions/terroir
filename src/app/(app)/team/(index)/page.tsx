import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
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

  const pendingInvitations = (invitations ?? []).map((inv) => ({
    id: inv.id,
    token: inv.token,
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
        members={(members ?? []).map((m) => ({
          id: m.id,
          user_id: m.user_id,
          role: m.role as "owner" | "manager" | "staff",
          created_at: m.created_at,
        }))}
        invitations={pendingInvitations}
        currentUserId={auth.user.id}
        restaurantName={restaurantName}
        canInvite={userRole === "owner"}
      />
      {canViewAnalytics && <MemberAnalyticsSection />}
    </section>
  );
}
