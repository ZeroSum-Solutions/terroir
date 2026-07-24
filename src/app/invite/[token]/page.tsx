"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotencyKey,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "@/lib/api/idempotency-client";

const INVITE_COMMAND_STORAGE_KEY = "terroir:invite-acceptance";

type StoredInviteCommand = {
  token: string;
  key: string;
};

function readStoredCommand(token: string): StoredInviteCommand | null {
  try {
    const raw = sessionStorage.getItem(INVITE_COMMAND_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredInviteCommand>;
    if (
      value.token !== token ||
      typeof value.key !== "string" ||
      value.key.length < 8
    ) {
      return null;
    }
    return { token, key: value.key };
  } catch {
    return null;
  }
}

function storeCommand(command: StoredInviteCommand): void {
  try {
    sessionStorage.setItem(INVITE_COMMAND_STORAGE_KEY, JSON.stringify(command));
  } catch {
    // The in-memory ref still protects strict-mode and same-mount retries.
  }
}

function clearStoredCommand(token: string): void {
  try {
    const stored = readStoredCommand(token);
    if (stored) sessionStorage.removeItem(INVITE_COMMAND_STORAGE_KEY);
  } catch {
    // Storage availability cannot change the server-side result.
  }
}

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const commandRef = useRef<StoredInviteCommand | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [canRetry, setCanRetry] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

    async function accept() {
      setStatus("loading");
      setMessage("");
      setCanRetry(false);

      const existing =
        commandRef.current?.token === params.token
          ? commandRef.current
          : readStoredCommand(params.token);
      const command = existing ?? {
        token: params.token,
        key: createIdempotencyKey(),
      };
      commandRef.current = command;
      storeCommand(command);

      try {
        const res = await fetch("/api/team/accept-invite", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": command.key,
          },
          body: JSON.stringify({ token: params.token }),
        });
        const data = await res.json();
        if (cancelled) return;

        if (res.ok) {
          clearStoredCommand(params.token);
          commandRef.current = null;
          setStatus("success");
          setMessage(data.message ?? "You have joined the restaurant.");
          redirectTimer = setTimeout(() => router.push("/"), 2000);
          return;
        }

        if (res.status === 401) {
          router.push(`/login?next=/invite/${params.token}`);
          return;
        }

        const retain = shouldRetainIdempotencyKey(
          res.status,
          readApiErrorCode(data),
        );
        if (!retain) {
          clearStoredCommand(params.token);
          commandRef.current = null;
        }
        setCanRetry(retain);
        setStatus("error");
        setMessage(readApiError(data, "Failed to accept invitation.").message);
      } catch {
        if (cancelled) return;
        setCanRetry(true);
        setStatus("error");
        setMessage(
          "The invitation response was interrupted. Retry to check the same request safely.",
        );
      }
    }

    void accept();
    return () => {
      cancelled = true;
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [attempt, params.token, router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-md">
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-lg text-center">
        {status === "loading" && (
          <>
            <Loader2
              className="mx-auto h-8 w-8 animate-spin text-accent"
              aria-hidden="true"
            />
            <p className="mt-md text-[15px] text-ink">Joining restaurant...</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-soft">
              <Check
                className="h-6 w-6 text-success"
                strokeWidth={2.5}
                aria-hidden="true"
              />
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
              <X
                className="h-6 w-6 text-error"
                strokeWidth={2.5}
                aria-hidden="true"
              />
            </div>
            <p className="mt-md text-[15px] font-medium text-ink">{message}</p>
            <button
              type="button"
              onClick={() =>
                canRetry ? setAttempt((value) => value + 1) : router.push("/login")
              }
              className="mt-lg flex mx-auto h-[44px] items-center gap-xs rounded-sm bg-accent px-md text-[14px] font-medium text-white hover:bg-accent-hover"
            >
              {canRetry && <RotateCcw className="h-4 w-4" aria-hidden="true" />}
              {canRetry ? "Try again" : "Go to login"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
