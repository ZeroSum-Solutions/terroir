import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/api/safe-redirect";

// "/" hits the role-aware redirector at src/app/page.tsx, which sends
// the user to /insights (owner) or /cellar (manager/staff). Hardcoding
// "/scanner" here would override that for users who hit the magic link
// without a `next` param.
const DEFAULT_POST_LOGIN_PATH = "/";

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

  // Password recovery flow: after exchanging the recovery code, redirect to
  // a dedicated page where the user sets their new password.
  const type = searchParams.get("type");
  if (type === "recovery") {
    return NextResponse.redirect(`${origin}/auth/reset-password`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
