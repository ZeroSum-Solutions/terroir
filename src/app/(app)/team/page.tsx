import { getAuthContext } from "@/lib/auth-context";
import { TeamActions } from "./team-actions";

export default async function TeamPage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const { supabase, restaurantId, restaurantName } = auth;

  const [{ data: members }, { data: invitations }] = await Promise.all([
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
        <h1 className="font-serif text-[28px] text-ink">Team</h1>
        <p className="mt-xs text-[15px] text-ink-muted">{restaurantName}</p>
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
      />
    </section>
  );
}
