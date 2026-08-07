"use client";

import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasCapability, type MembershipRole } from "@/lib/auth/capabilities";
import {
  BACKGROUND_JOB_PROGRESS_SELECT,
  backgroundJobDisplayState,
  backgroundJobHref,
  backgroundJobLabel,
  backgroundJobPollDelay,
  backgroundJobStatusCopy,
  isBackgroundJobActive,
  parseBackgroundJobSummaries,
  type BackgroundJobDisplayState,
  type BackgroundJobSummary,
} from "@/lib/jobs/progress";
import { createClient } from "@/lib/supabase/client";

type Props = {
  initialJobs: BackgroundJobSummary[];
  restaurantId: string;
  userRole: MembershipRole;
};

type RefreshOptions = { restartWindow?: boolean };

export function BackgroundJobProgress({
  initialJobs,
  restaurantId,
  userRole,
}: Props) {
  const [jobs, setJobs] = useState(initialJobs);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPollingPaused, setIsPollingPaused] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);
  const pollWindowStartedAtRef = useRef<number | null>(null);
  const requestSequenceRef = useRef(0);

  const client = useCallback(() => {
    clientRef.current ??= createClient();
    return clientRef.current;
  }, []);

  const refreshJobs = useCallback(
    async (options: RefreshOptions = {}): Promise<BackgroundJobSummary[] | null> => {
      if (options.restartWindow) {
        pollWindowStartedAtRef.current = Date.now();
        setIsPollingPaused(false);
      }

      const requestSequence = ++requestSequenceRef.current;
      setIsRefreshing(true);
      try {
        const { data, error } = await client()
          .from("background_jobs")
          .select(BACKGROUND_JOB_PROGRESS_SELECT)
          .eq("restaurant_id", restaurantId)
          .order("updated_at", { ascending: false })
          .limit(20);
        if (requestSequence !== requestSequenceRef.current) return null;
        if (error) throw error;

        const nextJobs = parseBackgroundJobSummaries(data ?? []);
        setJobs(nextJobs);
        setRefreshError(null);
        setLastCheckedAt(Date.now());
        return nextJobs;
      } catch {
        if (requestSequence === requestSequenceRef.current) {
          setRefreshError(
            "Job status could not be refreshed. Showing the last known state.",
          );
        }
        return null;
      } finally {
        if (requestSequence === requestSequenceRef.current) {
          setIsRefreshing(false);
        }
      }
    },
    [client, restaurantId],
  );

  useEffect(() => {
    pollWindowStartedAtRef.current = Date.now();
    const timeout = window.setTimeout(() => void refreshJobs(), 0);
    return () => window.clearTimeout(timeout);
  }, [refreshJobs]);

  useEffect(() => {
    if (!isOnline || isPollingPaused || isRefreshing) return;
    const elapsed = Date.now() - (pollWindowStartedAtRef.current ?? Date.now());
    const delay = backgroundJobPollDelay(jobs, elapsed);
    if (delay === null) {
      setIsPollingPaused(true);
      return;
    }
    const timeout = window.setTimeout(() => {
      void refreshJobs();
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [isOnline, isPollingPaused, isRefreshing, jobs, lastCheckedAt, refreshJobs]);

  useEffect(() => {
    const recover = () => {
      if (document.visibilityState === "visible") {
        void refreshJobs({ restartWindow: true });
      }
    };
    const online = () => {
      setIsOnline(true);
      void refreshJobs({ restartWindow: true });
    };
    const offline = () => setIsOnline(false);

    window.addEventListener("focus", recover);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("pageshow", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pageshow", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [refreshJobs]);

  const retryJob = useCallback(
    async (job: BackgroundJobSummary) => {
      if (!hasCapability(userRole, "job:retry")) return;
      setRetryingIds((current) => new Set(current).add(job.id));
      setRetryErrors((current) => ({ ...current, [job.id]: "" }));
      try {
        const { data, error } = await client().rpc("requeue_background_job", {
          p_job_id: job.id,
          p_restaurant_id: restaurantId,
        });
        if (error) {
          const reconciled = await refreshJobs({ restartWindow: true });
          if (reconciled?.some((candidate) =>
            candidate.id === job.id && candidate.status === "queued"
          )) {
            return;
          }
          setRetryErrors((current) => ({
            ...current,
            [job.id]: error.code === "42501"
              ? "You no longer have permission to retry this job."
              : "Retry could not be confirmed. Status was refreshed.",
          }));
          return;
        }

        const [requeued] = parseBackgroundJobSummaries([data]);
        setJobs((current) => [
          requeued,
          ...current.filter((candidate) => candidate.id !== requeued.id),
        ]);
        setRefreshError(null);
        setLastCheckedAt(Date.now());
        pollWindowStartedAtRef.current = Date.now();
        setIsPollingPaused(false);
      } catch {
        await refreshJobs({ restartWindow: true });
        setRetryErrors((current) => ({
          ...current,
          [job.id]: "Retry could not be confirmed. Status was refreshed.",
        }));
      } finally {
        setRetryingIds((current) => {
          const next = new Set(current);
          next.delete(job.id);
          return next;
        });
      }
    },
    [client, refreshJobs, restaurantId, userRole],
  );

  if (jobs.length === 0 && refreshError === null) return null;

  const canRetry = hasCapability(userRole, "job:retry");
  const hasActiveJob = jobs.some(isBackgroundJobActive);

  return (
    <section
      aria-labelledby="background-work-heading"
      className="mb-lg rounded-md border border-border bg-white p-md shadow-sm"
      data-testid="background-job-progress"
    >
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div>
          <h2
            id="background-work-heading"
            className="font-serif text-[18px] font-medium text-ink"
          >
            Background work
          </h2>
          <p className="text-[12px] text-ink-muted">
            Progress follows you across invoice, enrichment, and PDF screens.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshJobs({ restartWindow: true })}
          disabled={isRefreshing || !isOnline}
          className="inline-flex min-h-11 items-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4${isRefreshing ? " animate-spin" : ""}`}
            aria-hidden="true"
          />
          Refresh status
        </button>
      </div>

      <div className="mt-md grid gap-sm" aria-live="polite" aria-atomic="false">
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            canRetry={canRetry}
            isRetrying={retryingIds.has(job.id)}
            job={job}
            onRetry={retryJob}
            retryError={retryErrors[job.id]}
          />
        ))}
      </div>

      <div className="mt-sm text-[12px] text-ink-muted" role="status">
        {!isOnline
          ? "Offline. Showing the last known status; reconnect to refresh."
          : isPollingPaused && hasActiveJob
            ? "Automatic updates paused after five minutes. Refresh status to continue."
            : refreshError ?? (hasActiveJob ? "Automatic updates are on." : "Status is up to date.")}
      </div>
    </section>
  );
}

function JobRow({
  canRetry,
  isRetrying,
  job,
  onRetry,
  retryError,
}: {
  canRetry: boolean;
  isRetrying: boolean;
  job: BackgroundJobSummary;
  onRetry: (job: BackgroundJobSummary) => Promise<void>;
  retryError?: string;
}) {
  const state = backgroundJobDisplayState(job);
  const copy = backgroundJobStatusCopy(job);
  const isFailed = state === "failed" || state === "dead_letter";

  return (
    <article className="flex flex-col gap-sm rounded-sm border border-border bg-surface px-sm py-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-sm">
        <StatusIcon state={state} />
        <div className="min-w-0">
          <Link
            href={backgroundJobHref(job)}
            className="text-[13px] font-medium text-ink underline-offset-2 hover:text-accent hover:underline"
          >
            {backgroundJobLabel(job)}
          </Link>
          <p className="text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{copy.label}</span>
            {" · "}
            {copy.detail}
          </p>
          {retryError && (
            <p className="mt-xs text-[12px] text-danger" role="alert">
              {retryError}
            </p>
          )}
        </div>
      </div>
      {isFailed && canRetry && (
        <button
          type="button"
          onClick={() => void onRetry(job)}
          disabled={isRetrying}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-xs rounded-sm border border-border-strong bg-white px-md text-[13px] font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
          aria-label={`Retry ${backgroundJobLabel(job)}`}
        >
          {isRetrying ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          )}
          {isRetrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </article>
  );
}

function StatusIcon({ state }: { state: BackgroundJobDisplayState }) {
  const className = "mt-0.5 h-4 w-4 shrink-0";
  switch (state) {
    case "queued":
      return <Clock3 className={`${className} text-ink-muted`} aria-hidden="true" />;
    case "running":
    case "retrying":
      return <Loader2 className={`${className} animate-spin text-warning`} aria-hidden="true" />;
    case "succeeded":
      return <CheckCircle2 className={`${className} text-success`} aria-hidden="true" />;
    case "cancelled":
      return <XCircle className={`${className} text-ink-muted`} aria-hidden="true" />;
    case "failed":
    case "dead_letter":
      return <AlertCircle className={`${className} text-danger`} aria-hidden="true" />;
  }
}
