import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidTemporaryBypassToken } from "@/lib/auth/temporary-bypass";

/**
 * Dev-only auth bypass. Mints a Supabase magic-link token server-side via
 * the admin API, then verifies it server-side against the caller's
 * cookie-bound Supabase client — setting the auth session cookies
 * directly. The browser never leaves localhost, so this works inside
 * Claude Code's preview sandbox (which blocks external-origin redirects).
 *
 * In development, DEV_BYPASS_EMAIL enables the route. In production, it is
 * unavailable unless TEMP_AUTH_BYPASS_EMAIL, TEMP_AUTH_BYPASS_TOKEN_SHA256,
 * and TEMP_AUTH_BYPASS_EXPIRES_AT are explicitly configured. Never use
 * NEXT_PUBLIC_ for these values: Next.js inlines that prefix into the client
 * bundle.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const isProduction = process.env.NODE_ENV === "production";
  const email = isProduction
    ? process.env.TEMP_AUTH_BYPASS_EMAIL
    : process.env.DEV_BYPASS_EMAIL;

  if (
    isProduction &&
    !isValidTemporaryBypassToken(
      process.env.TEMP_AUTH_BYPASS_TOKEN_SHA256,
      process.env.TEMP_AUTH_BYPASS_EXPIRES_AT,
      request.nextUrl.searchParams.get("token"),
    )
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!email || !serviceRoleKey || !supabaseUrl) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Step 1: ask Supabase admin to mint a magic-link token for the target
  // user. We get back `hashed_token` — the same one-time proof of
  // identity that the email link would carry.
  const genRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ type: "magiclink", email }),
    cache: "no-store",
  });

  if (!genRes.ok) {
    const text = await genRes.text();
    return NextResponse.json(
      { error: `Admin generate_link failed (${genRes.status}): ${text}` },
      { status: 502 },
    );
  }

  const payload = (await genRes.json()) as { hashed_token?: string };
  if (!payload.hashed_token) {
    return NextResponse.json(
      { error: "Admin response missing hashed_token." },
      { status: 502 },
    );
  }

  // Step 2: verify the token against the caller's own cookie-bound
  // Supabase client. verifyOtp succeeds → sb-access-token and
  // sb-refresh-token cookies get set on the response, logging the
  // browser in without ever leaving this origin (critical for
  // Claude Code's preview sandbox, which blocks external redirects).
  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: payload.hashed_token,
    type: "magiclink",
  });

  if (verifyError) {
    return NextResponse.json(
      { error: `verifyOtp failed: ${verifyError.message}` },
      { status: 502 },
    );
  }

  // Step 3: redirect same-origin to /. Session cookies are
  // already attached to this response by the verifyOtp call above.
  const hdrs = request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3000";
  const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return NextResponse.redirect(`${proto}://${host}/`, { status: 303 });
}
