"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function accept() {
      try {
        const res = await fetch("/api/team/accept-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: params.token }),
        });

        const data = await res.json().catch(() => null);

        if (res.ok) {
          setStatus("success");
          setMessage(data?.message ?? "You have joined the restaurant.");
          // Redirect to role-aware home after 2 seconds; "/" hits the
          // redirector at src/app/page.tsx which sends the user to
          // /insights (owner) or /cellar (manager/staff).
          setTimeout(() => router.push("/"), 2000);
        } else {
          if (res.status === 401) {
            // Not logged in — redirect to login with return URL
            router.push(`/login?next=/invite/${params.token}`);
            return;
          }
          setStatus("error");
          setMessage(readApiError(data, "Failed to accept invitation.").message);
        }
      } catch {
        setStatus("error");
        setMessage("Failed to accept invitation.");
      }
    }

    accept();
  }, [params.token, router]);

  return (
    <main className="dawn-gradient flex min-h-screen items-center justify-center px-md py-lg sm:px-lg sm:py-xl">
      <div className="glass w-full max-w-[420px] rounded-card p-lg text-center sm:p-xl">
        <div className="mb-lg font-sans text-[13px] font-medium uppercase tracking-[0.22em] text-ink">
          TERR<span className="text-primary">OIR</span>
        </div>
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" aria-hidden="true" />
            <p className="mt-md text-[15px] text-ink">Joining restaurant…</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-sage-wash">
              <Check className="h-6 w-6 text-sage-ink" strokeWidth={2.5} aria-hidden="true" />
            </div>
            <p className="mt-md font-serif text-[19px] font-medium text-ink">{message}</p>
            <p className="mt-xs text-[13px] text-grey">
              Redirecting to Terroir…
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blush-wash">
              <X className="h-6 w-6 text-primary" strokeWidth={2.5} aria-hidden="true" />
            </div>
            <p className="mt-md text-[15px] font-medium text-ink">{message}</p>
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="mx-auto mt-lg flex min-h-11 items-center rounded-pill bg-primary px-lg text-[14px] font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 focus-visible:ring-offset-2"
            >
              Go to login
            </button>
          </>
        )}
      </div>
    </main>
  );
}
