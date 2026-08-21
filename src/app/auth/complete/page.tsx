"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { safeNext } from "@/lib/api/safe-redirect";
import { AUTH_LINK_ERROR } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/client";

/**
 * Completion page for implicit-flow magic links (tokens in URL hash).
 * The PKCE flow from /login handles ?code=, this handles #access_token=.
 *
 * Used by admin-generated links (auth.admin.generateLink) and any other
 * flow that returns tokens in the hash fragment.
 */
export default function AuthCompletePage() {
  const router = useRouter();

  useEffect(() => {
    void (async () => {
      const fail = () => {
        history.replaceState(null, "", window.location.pathname);
        router.replace(`/login?error=${AUTH_LINK_ERROR}`);
      };
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) {
        fail();
        return;
      }
      const params = new URLSearchParams(hash);
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      const hash_error = params.get("error_description");

      if (hash_error) {
        fail();
        return;
      }
      if (!access_token || !refresh_token) {
        fail();
        return;
      }

      const supabase = createClient();
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) {
        fail();
        return;
      }
      const next = safeNext(
        new URLSearchParams(window.location.search).get("next"),
        "/",
      );
      history.replaceState(null, "", window.location.pathname);
      router.replace(next);
    })();
  }, [router]);

  return (
    <main className="dawn-gradient flex min-h-screen items-center justify-center px-lg">
      <div className="text-center">
        <p className="text-[14px] font-light text-grey">Signing you in…</p>
      </div>
    </main>
  );
}
