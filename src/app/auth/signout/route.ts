import { NextResponse, type NextRequest } from "next/server";
import { loginUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  // Auth redirects are pinned to the configured deployment origin. Never
  // derive them from a caller-controlled Host header or request URL.
  void request;
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "global" });
  return NextResponse.redirect(loginUrl(), {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
