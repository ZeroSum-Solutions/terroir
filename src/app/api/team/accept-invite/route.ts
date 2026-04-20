import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/api/rate-limit";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Max accept-invite attempts per authed user per IP per hour. */
const ACCEPT_INVITE_LIMIT = 10;
/** Rate-limit window in ms (one hour). */
const ACCEPT_INVITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Best-effort client-IP extraction. Vercel sets `x-forwarded-for`; fallback to
 * `x-real-ip` for other reverse proxies. Only the leftmost IP in the list is
 * used. `unknown` is never a realistic value in production, but is a sane
 * fallback for local/test so the key is still stable.
 */
function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // BND-013: rate-limit authed users before we touch the DB. The key is
  // `${ip}:${user.id}` so a single user can't brute-force tokens from one
  // IP, and a single IP can't brute-force across many throwaway accounts.
  const limit = rateLimit(
    `accept-invite:${clientIp(request)}:${user.id}`,
    ACCEPT_INVITE_LIMIT,
    ACCEPT_INVITE_WINDOW_MS,
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many invitation attempts. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.token) {
    return NextResponse.json(
      { error: "Invitation token is required." },
      { status: 400 },
    );
  }

  // Find the invitation
  const { data: invitation, error: findError } = await supabase
    .from("invitations")
    .select("id, restaurant_id, role, expires_at, accepted_at")
    .eq("token", body.token)
    .single();

  if (findError || !invitation) {
    return NextResponse.json(
      { error: "Invalid or expired invitation." },
      { status: 404 },
    );
  }

  if (invitation.accepted_at) {
    return NextResponse.json(
      { error: "This invitation has already been used." },
      { status: 400 },
    );
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return NextResponse.json(
      { error: "This invitation has expired." },
      { status: 400 },
    );
  }

  // Check if user already has a membership for this restaurant
  const { data: existingMembership } = await supabase
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("restaurant_id", invitation.restaurant_id)
    .limit(1)
    .single();

  if (existingMembership) {
    // Mark invitation as accepted but don't create a duplicate membership
    await supabase
      .from("invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    return NextResponse.json({
      success: true,
      message: "You are already a member of this restaurant.",
      restaurantId: invitation.restaurant_id,
    });
  }

  // Create the membership
  const { error: membershipError } = await supabase
    .from("memberships")
    .insert({
      user_id: user.id,
      restaurant_id: invitation.restaurant_id,
      role: invitation.role,
    });

  if (membershipError) {
    console.error("membership insert failed:", membershipError);
    return NextResponse.json(
      { error: "Failed to join restaurant." },
      { status: 500 },
    );
  }

  // Mark invitation as accepted
  await supabase
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invitation.id);

  return NextResponse.json({
    success: true,
    restaurantId: invitation.restaurant_id,
    role: invitation.role,
  });
}
