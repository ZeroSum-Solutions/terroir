import { NextResponse, type NextRequest } from "next/server";

/**
 * Dev-only auth bypass. Mints a Supabase magic link server-side via the
 * service-role admin API and redirects the browser to it, completing
 * sign-in without the email round trip.
 *
 * Gated by DEV_BYPASS_EMAIL (server-only) — absent = endpoint returns 404.
 * Also hard-gated off in production regardless of env vars. Never use the
 * NEXT_PUBLIC_ prefix for this variable: Next.js inlines NEXT_PUBLIC_* into
 * the client bundle, which would leak a valid login target to any browser.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // Hard gate: this endpoint must never exist in production, even by mistake.
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const email = process.env.DEV_BYPASS_EMAIL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!email || !serviceRoleKey || !supabaseUrl) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Use the Host header rather than request.url — Next resolves request.url
  // against the server's listening address (localhost) even when the client
  // hit the box via a LAN IP, which would send Supabase back to localhost.
  const hdrs = request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3000";
  const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const redirectTo = `${proto}://${host}/auth/complete`;

  const res = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ type: "magiclink", email }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `Admin generate_link failed (${res.status}): ${text}` },
      { status: 502 },
    );
  }

  const payload = (await res.json()) as {
    hashed_token?: string;
  };
  if (!payload.hashed_token) {
    return NextResponse.json(
      { error: "Admin response missing hashed_token." },
      { status: 502 },
    );
  }

  const verifyUrl = new URL(`${supabaseUrl}/auth/v1/verify`);
  verifyUrl.searchParams.set("token", payload.hashed_token);
  verifyUrl.searchParams.set("type", "magiclink");
  verifyUrl.searchParams.set("redirect_to", redirectTo);

  return NextResponse.redirect(verifyUrl.toString(), { status: 303 });
}
