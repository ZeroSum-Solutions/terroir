"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, Loader2, X } from "lucide-react";

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function accept() {
      const res = await fetch("/api/team/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: params.token }),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus("success");
        setMessage(data.message ?? "You have joined the restaurant.");
        // Redirect to scanner after 2 seconds
        setTimeout(() => router.push("/scanner"), 2000);
      } else {
        if (res.status === 401) {
          // Not logged in — redirect to login with return URL
          router.push(`/login?next=/invite/${params.token}`);
          return;
        }
        setStatus("error");
        setMessage(data.error ?? "Failed to accept invitation.");
      }
    }

    accept();
  }, [params.token, router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-md">
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-lg text-center">
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-accent" aria-hidden="true" />
            <p className="mt-md text-[15px] text-ink">Joining restaurant...</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-soft">
              <Check className="h-6 w-6 text-success" strokeWidth={2.5} aria-hidden="true" />
            </div>
            <p className="mt-md text-[15px] font-medium text-ink">{message}</p>
            <p className="mt-xs text-[13px] text-ink-muted">
              Redirecting to Terroir...
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-error/10">
              <X className="h-6 w-6 text-error" strokeWidth={2.5} aria-hidden="true" />
            </div>
            <p className="mt-md text-[15px] font-medium text-ink">{message}</p>
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="mt-lg flex mx-auto h-[38px] items-center rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
            >
              Go to login
            </button>
          </>
        )}
      </div>
    </main>
  );
}
