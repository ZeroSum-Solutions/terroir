import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/api/auth";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * POST /api/team/invite/[id]/resend — resend a pending invitation.
 * Creates a new invitation row with the same email and role as the
 * original. The old invitation row remains valid and must be explicitly
 * revoked via DELETE /api/team/invite/[id] if no longer needed.
 *
 * Owner-only. Returns 404 if the invitation doesn't exist (or belongs to
 * another restaurant), 400 if it has already been accepted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Params },
) {
  const { id } = await params;
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { supabase, user, restaurantId } = auth;

  // Fetch the original invitation
  const { data: original } = await supabase
    .from("invitations")
    .select("id, email, role, accepted_at")
    .eq("id", id)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!original) {
    return NextResponse.json(
      { error: "Invitation not found." },
      { status: 404 },
    );
  }

  if (original.accepted_at) {
    return NextResponse.json(
      { error: "Invitation already accepted. No need to resend." },
      { status: 400 },
    );
  }

  // Create a fresh invitation with the same email + role
  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      restaurant_id: restaurantId,
      email: original.email,
      role: original.role,
      invited_by: user.id,
    })
    .select("id, token, role, email, expires_at, created_at")
    .single();

  if (error || !invitation) {
    console.error("invitation resend insert failed:", error);
    Sentry.captureException(
      error ?? new Error("invitation resend insert returned null"),
      {
        tags: { surface: "team-invite", phase: "resend-insert" },
        extra: { restaurantId, originalId: id },
      },
    );
    return NextResponse.json(
      { error: "Failed to resend invitation." },
      { status: 500 },
    );
  }

  const origin = request.headers.get("origin") ?? request.nextUrl.origin;
  const inviteUrl = `${origin}/invite/${invitation.token}`;

  return NextResponse.json({ ...invitation, inviteUrl });
}
