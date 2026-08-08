import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type RemovalResult = {
  outcome: "removed" | "not_found" | "self_removal";
  response_status: number;
  response_body: Json;
  replayed: boolean;
  execution_started_at: string;
};

export async function removeTeamMembership({
  supabase,
  restaurantId,
  membershipId,
}: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  membershipId: string;
}) {
  const { data, error } = await supabase.rpc(
    "remove_team_member_idempotent",
    {
      p_restaurant_id: restaurantId,
      p_member_id: membershipId,
    },
  );
  if (error) throw error;

  const row = validRemovalResult(data);
  if (!row) {
    throw new Error(
      "remove_team_member_idempotent returned an invalid result",
    );
  }
  return {
    status: row.response_status,
    body: row.response_body,
  };
}

function validRemovalResult(data: unknown): RemovalResult | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row = data[0] as RemovalResult | null;
  if (
    !row ||
    !["removed", "not_found", "self_removal"].includes(row.outcome) ||
    row.replayed !== false ||
    typeof row.execution_started_at !== "string" ||
    Number.isNaN(Date.parse(row.execution_started_at)) ||
    row.response_body === null ||
    typeof row.response_body !== "object"
  ) {
    return null;
  }

  const expectedStatus = {
    removed: 200,
    not_found: 404,
    self_removal: 400,
  }[row.outcome];
  return row.response_status === expectedStatus ? row : null;
}
