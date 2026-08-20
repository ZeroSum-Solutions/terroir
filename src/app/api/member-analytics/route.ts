import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api/auth";
import { withApiHandler } from "@/lib/api/handler";
import { buildMemberAnalytics, type MemberRole } from "@/lib/member-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1_000;

export async function GET() {
  return withApiHandler(getMemberAnalytics);
}

async function getMemberAnalytics() {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;

  const [memberships, pours, adjustments, closeouts] = await Promise.all([
    fetchAll((from, to) => auth.supabase
      .from("memberships")
      .select("id, user_id, role")
      .eq("restaurant_id", auth.restaurantId)
      .order("id")
      .range(from, to)),
    fetchAll((from, to) => auth.supabase
      .from("pour_events")
      .select("actor_user_id, ml_delta, kind")
      .eq("restaurant_id", auth.restaurantId)
      .order("id")
      .range(from, to)),
    fetchAll((from, to) => auth.supabase
      .from("stock_adjustments")
      .select("acting_user_id, kind")
      .eq("restaurant_id", auth.restaurantId)
      .order("id")
      .range(from, to)),
    fetchAll((from, to) => auth.supabase
      .from("bottle_closeouts")
      .select("closed_by, variance_ml")
      .eq("restaurant_id", auth.restaurantId)
      .order("id")
      .range(from, to)),
  ]);

  const result = buildMemberAnalytics({
    members: memberships.map((member) => ({
      memberId: member.id,
      userId: member.user_id,
      role: member.role as MemberRole,
    })),
    pours: pours.map((pour) => ({
      actorUserId: pour.actor_user_id,
      mlDelta: pour.ml_delta,
      kind: pour.kind,
    })),
    adjustments: adjustments.map((adjustment) => ({
      actingUserId: adjustment.acting_user_id,
      kind: adjustment.kind,
    })),
    closeouts: closeouts.map((closeout) => ({
      closedBy: closeout.closed_by,
      varianceMl: closeout.variance_ml,
    })),
  });
  return NextResponse.json(result);
}

async function fetchAll<T>(
  queryPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}
