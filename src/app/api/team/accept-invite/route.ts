import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { rateLimit } from "@/lib/api/rate-limit";
import { Errors } from "@/lib/api/errors";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

export const runtime = "nodejs";

/** Max accept-invite attempts per authed user per IP per hour. */
const ACCEPT_INVITE_LIMIT = 10;
/** Rate-limit window in ms (one hour). */
const ACCEPT_INVITE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Best-effort client-IP extraction. Any fronting proxy (Railway's envoy,
 * Cloudflare, nginx, etc.) sets `x-forwarded-for`; fallback to
 * `x-real-ip` for others. Only the leftmost IP in the list is used.
 * `unknown` is never a realistic value in production, but is a sane
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
    return Errors.unauthorized();
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
      { error: { code: "rate_limited", message: "Too many invitation attempts. Try again later." } },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return Errors.badRequest("Invalid JSON.");
  }

  if (!body.token) {
    return Errors.badRequest("Invitation token is required.");
  }

  // The invitee is not a restaurant member yet, so authenticated RLS cannot
  // read the invitation or create the first membership. Keep identity proof on
  // the user's client above, then use the server-only client for this bounded
  // token + email-bound acceptance transaction.
  const service = createServiceRoleClient();
  if (!service) {
    return Errors.internal("Failed to accept invitation.");
  }

  // Find the invitation
  const { data: invitation, error: findError } = await service
    .from("invitations")
    .select("id, restaurant_id, role, email, expires_at, accepted_at")
    .eq("token", body.token)
    .single();

  if (findError || !invitation) {
    return Errors.notFound("Invalid or expired invitation.");
  }

  // BND-011: email-binding enforcement. Mismatch returns the same opaque
  // 404 used for token-not-found so a brute-forcer can't distinguish
  // "valid token, wrong user" from "no such token".
  const inviteeEmail = invitation.email?.trim().toLowerCase();
  const userEmail = user.email?.trim().toLowerCase();
  if (!inviteeEmail || !userEmail || inviteeEmail !== userEmail) {
    return Errors.notFound("Invalid or expired invitation.");
  }

  // Check if user already has a membership for this restaurant
  const { data: existingMembership } = await service
    .from("memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("restaurant_id", invitation.restaurant_id)
    .limit(1)
    .single();

  if (existingMembership) {
    // Mark invitation as accepted but don't create a duplicate membership
    await service
      .from("invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    return NextResponse.json({
      success: true,
      message: "You are already a member of this restaurant.",
      restaurantId: invitation.restaurant_id,
    });
  }

  if (invitation.accepted_at) {
    return Errors.badRequest("This invitation has already been used.");
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return Errors.badRequest("This invitation has expired.");
  }

  // Create the membership
  const { error: membershipError } = await service
    .from("memberships")
    .insert({
      user_id: user.id,
      restaurant_id: invitation.restaurant_id,
      role: invitation.role,
    });

  if (membershipError && membershipError.code !== "23505") {
    console.error("membership insert failed:", membershipError);
    Sentry.captureException(membershipError, {
      tags: { surface: "team-accept-invite", phase: "membership-insert" },
      extra: {
        userId: user.id,
        restaurantId: invitation.restaurant_id,
        invitationId: invitation.id,
      },
    });
    return Errors.internal("Failed to join restaurant.");
  }

  // Mark invitation as accepted
  await service
    .from("invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invitation.id);

  return NextResponse.json({
    success: true,
    restaurantId: invitation.restaurant_id,
    role: invitation.role,
  });
}
