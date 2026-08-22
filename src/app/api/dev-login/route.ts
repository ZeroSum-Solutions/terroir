import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { createClient } from "@/lib/supabase/server";

/**
 * Dev-only auth bypass. Mints a Supabase magic-link token server-side via
 * the admin API, then verifies it server-side against the caller's
 * cookie-bound Supabase client — setting the auth session cookies
 * directly. The browser never leaves localhost, so this works inside
 * Claude Code's preview sandbox (which blocks external-origin redirects).
 *
 * DEV_BYPASS_EMAIL enables the route outside production. Production always
 * returns an opaque 404, regardless of legacy temporary-bypass variables —
 * unconditionally, before any env var beyond NODE_ENV is even read, so the
 * disabled path in production is a single early return with no branching
 * on token/capability state (see docs/BREAK-GLASS.md).
 *
 * Every enabled invocation (the only case that reaches this route's real
 * logic) is reported to Sentry with the actor email, timestamp, and reason,
 * so any bypass login is auditable — see docs/BREAK-GLASS.md.
 */
export const runtime = "nodejs";

const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const GenerateLinkSchema = z.object({
  hashed_token: z.string().min(1).max(4096),
});

function opaqueNotFound() {
  return new NextResponse("Not found", {
    status: 404,
    headers: SAFE_HEADERS,
  });
}

function temporaryLoginUnavailable() {
  return Errors.badGateway("Temporary login unavailable.", {
    headers: SAFE_HEADERS,
  });
}

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return opaqueNotFound();

  const email = process.env.DEV_BYPASS_EMAIL;

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!email || !serviceRoleKey || !supabaseUrl) {
    return opaqueNotFound();
  }

  // Audit trail: every enabled invocation is reported, regardless of the
  // eventual outcome, so bypass usage is never silent. See
  // docs/BREAK-GLASS.md for the retention/rotation policy this backs.
  Sentry.captureMessage("dev-login bypass invoked", {
    level: "warning",
    tags: { route: "dev-login" },
    extra: {
      actor: email,
      time: new Date().toISOString(),
      reason: `DEV_BYPASS_EMAIL enabled outside production (NODE_ENV=${process.env.NODE_ENV})`,
    },
  });

  try {
    // Step 1: ask Supabase admin to mint a one-time magic-link proof.
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
    if (!genRes.ok) return temporaryLoginUnavailable();

    const parsed = GenerateLinkSchema.safeParse(await genRes.json());
    if (!parsed.success) return temporaryLoginUnavailable();

    // Step 2: verify the proof against the caller's cookie-bound client.
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash: parsed.data.hashed_token,
      type: "magiclink",
    });
    if (error) return temporaryLoginUnavailable();
  } catch {
    return temporaryLoginUnavailable();
  }

  // Step 3: redirect same-origin to /. Session cookies are
  // already attached to this response by the verifyOtp call above.
  const hdrs = request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3000";
  const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return NextResponse.redirect(`${proto}://${host}/`, {
    status: 303,
    headers: SAFE_HEADERS,
  });
}
