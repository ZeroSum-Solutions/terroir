import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { apiError, Errors } from "@/lib/api/errors";
import { withApiHandler } from "@/lib/api/handler";
import { parseJson } from "@/lib/api/validation";
import { AcceptInviteBodySchema } from "@/lib/api/team-schemas";

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
  return withApiHandler(async () => {
    const auth = await requireAuth({ rateLimit: "sensitive" });
    if (auth instanceof NextResponse) return auth;
    const { supabase, user } = auth;

    const limit = rateLimit(
      `accept-invite:${clientIp(request)}:${user.id}`,
      ACCEPT_INVITE_LIMIT,
      ACCEPT_INVITE_WINDOW_MS,
    );
    if (!limit.ok) {
      return Errors.rateLimited(
        "Too many invitation attempts. Try again later.",
        { headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const parsed = await parseJson(request, AcceptInviteBodySchema);
    if (!parsed.ok) return parsed.response;

    const { data: invitation, error: findError } = await supabase
      .from("invitations")
      .select("id, restaurant_id, role, email, expires_at, accepted_at")
      .eq("token", parsed.data.token)
      .single();
    if (findError && (findError as { code?: string }).code !== "PGRST116") {
      throw findError;
    }
    const invalidInvitation = () =>
      apiError(404, "not_found", "Invalid or expired invitation.");
    if (!invitation) return invalidInvitation();

    const inviteeEmail = invitation.email?.trim().toLowerCase();
    const userEmail = user.email?.trim().toLowerCase();
    if (!inviteeEmail || !userEmail || inviteeEmail !== userEmail) {
      return invalidInvitation();
    }
    if (invitation.accepted_at) {
      return Errors.badRequest("This invitation has already been used.");
    }
    if (new Date(invitation.expires_at) < new Date()) {
      return Errors.badRequest("This invitation has expired.");
    }

    const { data: existingMembership, error: membershipLookupError } =
      await supabase
        .from("memberships")
        .select("id")
        .eq("user_id", user.id)
        .eq("restaurant_id", invitation.restaurant_id)
        .limit(1)
        .single();
    if (
      membershipLookupError &&
      (membershipLookupError as { code?: string }).code !== "PGRST116"
    ) {
      throw membershipLookupError;
    }

    if (!existingMembership) {
      const { error: membershipError } = await supabase
        .from("memberships")
        .insert({
          user_id: user.id,
          restaurant_id: invitation.restaurant_id,
          role: invitation.role,
        });
      if (membershipError) throw membershipError;
    }

    const { data: acceptedInvitation, error: acceptanceError } = await supabase
      .from("invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invitation.id)
      .select("id")
      .maybeSingle();
    if (acceptanceError) throw acceptanceError;
    if (!acceptedInvitation) return invalidInvitation();

    return NextResponse.json({
      success: true,
      ...(existingMembership
        ? { message: "You are already a member of this restaurant." }
        : { role: invitation.role }),
      restaurantId: invitation.restaurant_id,
    });
  });
}
