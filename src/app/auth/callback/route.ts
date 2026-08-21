import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/lib/api/safe-redirect";
import { AUTH_LINK_ERROR, appUrl, loginUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

const DEFAULT_POST_LOGIN_PATH = "/";
const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function authLinkFailure() {
  return NextResponse.redirect(loginUrl({ error: AUTH_LINK_ERROR }), {
    status: 303,
    headers: SAFE_HEADERS,
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"), DEFAULT_POST_LOGIN_PATH);

  if (!code) return authLinkFailure();

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return authLinkFailure();
  } catch {
    return authLinkFailure();
  }

  return NextResponse.redirect(appUrl(next), {
    status: 303,
    headers: SAFE_HEADERS,
  });
}
