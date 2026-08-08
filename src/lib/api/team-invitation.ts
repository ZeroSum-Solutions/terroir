import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export async function createTeamInvitation({
  supabase,
  restaurantId,
  userId,
  email,
  role,
  origin,
}: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  userId: string;
  email: string;
  role: "manager" | "staff";
  origin: string;
}) {
  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      restaurant_id: restaurantId,
      email,
      role,
      invited_by: userId,
    })
    .select("id, token, role, email, expires_at, created_at")
    .single();
  if (error || !invitation) {
    throw error ?? new Error("invitation insert returned no row");
  }

  return {
    status: 200,
    body: {
      ...invitation,
      inviteUrl: `${origin}/invite/${invitation.token}`,
    },
  };
}
