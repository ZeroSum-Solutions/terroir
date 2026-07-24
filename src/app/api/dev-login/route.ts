import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Errors } from "@/lib/api/errors";
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

const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const ProductionTokenSchema = z.string().min(1).max(512);
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

function readProductionToken(request: NextRequest): string | null {
  const tokens = request.nextUrl.searchParams.getAll("token");
  if (tokens.length !== 1) return null;
  const parsed = ProductionTokenSchema.safeParse(tokens[0]);
  return parsed.success ? parsed.data : null;
}

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
      readProductionToken(request),
    )
  ) {
    return opaqueNotFound();
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!email || !serviceRoleKey || !supabaseUrl) {
    return opaqueNotFound();
  }

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
