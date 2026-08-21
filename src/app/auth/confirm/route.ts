import { NextResponse, type NextRequest } from "next/server";
import { AUTH_LINK_ERROR, appUrl, loginUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

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
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (!tokenHash || tokenHash.length > 4096 || type !== "recovery") {
    return authLinkFailure();
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type: "recovery",
      token_hash: tokenHash,
    });
    if (error) return authLinkFailure();
  } catch {
    return authLinkFailure();
  }

  return NextResponse.redirect(appUrl("/auth/reset-password"), {
    status: 303,
    headers: SAFE_HEADERS,
  });
}
