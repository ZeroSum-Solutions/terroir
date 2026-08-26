import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - api routes (own auth)
     * - monitoring (BND-032: Sentry tunnelRoute — bypass Supabase session refresh)
     * - _next/static, _next/image (build output)
     * - favicon, manifest, robots, sitemap
     * - static files with extensions
     */
    "/((?!api|monitoring|_next/static|_next/image|favicon.ico|manifest\\.webmanifest$|manifest.json|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?)$).*)",
  ],
};
