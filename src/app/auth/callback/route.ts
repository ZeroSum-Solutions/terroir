import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/api/safe-redirect";

const DEFAULT_POST_LOGIN_PATH = "/scanner";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const hdrs = request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3000";
  const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  const code = searchParams.get("code");
  // BND-005: every `next` value from the query string is treated as untrusted.
  // safeNext enforces same-origin, path-only redirects and rejects any absolute
  // URL, protocol-relative path, or unsafe scheme, so `?next=//evil.com/x` no
  // longer turns into a cross-origin phish.
  const next = safeNext(searchParams.get("next"), DEFAULT_POST_LOGIN_PATH);
  const errorDescription = searchParams.get("error_description");

  if (errorDescription) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(errorDescription)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent("Missing auth code.")}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
