import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";
import {
  getSupabasePublicConfig,
  isProductionRuntime,
} from "@/lib/supabase/config";

const PUBLIC_PATHS = [
  "/login",
  "/auth/callback",
  "/auth/complete",
  "/api/dev-login",
  "/list",
  "/invite",
];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

/**
 * Runs in proxy.ts. Refreshes the Supabase session on every request
 * and redirects unauthenticated users hitting protected routes to /login.
 *
 * The response object MUST be the one we mutate and return — not a new
 * one — so cookie writes from token refresh land on the outgoing response.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { pathname } = request.nextUrl;
  const config = getSupabasePublicConfig();

  if (!config) {
    if (isProductionRuntime()) {
      return new NextResponse("Service unavailable.", { status: 503 });
    }
    return isPublic(pathname) ? response : redirectToLogin(request);
  }

  const supabase = createServerClient<Database>(
    config.url,
    config.publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Triggers session refresh if needed. Do not remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(pathname)) {
    return redirectToLogin(request);
  }

  if (user && pathname === "/login") {
    // "/" hits the role-aware redirector at src/app/page.tsx, sending
    // the user to /insights (owner) or /cellar (manager/staff). Was
    // hardcoded "/scanner" pre-IA-redesign.
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }

  return response;
}
