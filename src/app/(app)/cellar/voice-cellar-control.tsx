"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Mic, X } from "lucide-react";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import type {
  VoiceAvailabilityResponse,
  VoiceResolveResponse,
  VoiceWineItem,
} from "@/lib/wine-intelligence/voice-resolve-types";
import type { VoiceFilterPayload } from "@/lib/wine-intelligence/voice-filter-intent";

const AUTO_STOP_MS = 15_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"];

type Phase = "idle" | "requesting" | "recording" | "processing";

export function VoiceCellarControl({
  onResolve,
  onFilter,
}: {
  onResolve: (wineId: string) => void;
  onFilter: (filters: VoiceFilterPayload) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [ambiguity, setAmbiguity] = useState<{
    transcript: string;
    candidates: VoiceWineItem[];
  } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      return;
    }
    const controller = new AbortController();
    void fetch("/api/cellar/voice-resolve", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return { available: false };
        return (await response.json()) as VoiceAvailabilityResponse;
      })
      .then((result) => setAvailable(result.available))
      .catch(() => {
        if (!controller.signal.aborted) setAvailable(false);
      });
    return () => controller.abort();
  }, []);

  const releaseRecording = useCallback(() => {
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => releaseRecording, [releaseRecording]);

  const applyResult = useCallback(
    (result: VoiceResolveResponse) => {
      if (result.kind === "resolved") {
        setNotice(`Found ${result.item.producer} ${result.item.name}.`);
        onResolve(result.item.itemId);
      } else if (result.kind === "ambiguous") {
        setAmbiguity({
          transcript: result.transcript,
          candidates: result.candidates,
        });
      } else if (result.kind === "filter") {
        setNotice(`Showing ${result.label}.`);
        onFilter(result.filters);
      } else if (result.kind === "abstain") {
        setNotice(`Didn't catch a cellar wine — heard: ${result.transcript || "nothing"}.`);
      } else if (result.kind === "stt_failed") {
        setNotice(
          result.transcript
            ? `Voice search couldn't finish — heard: ${result.transcript}.`
            : "Voice search couldn't finish. Try again or use typed search.",
        );
      } else if (result.kind === "gated") {
        setNotice(
          result.reason === "empty_cellar"
            ? "Voice search is ready after bottles have been placed in the cellar."
            : "Voice search is not ready yet. Use typed search for now.",
        );
      } else {
        // e.g. kind "unavailable": the key vanished between GET and POST.
        // Keep the control mounted — setAvailable(false) here would unmount
        // the notice along with the mic, making the feature vanish silently.
        setNotice("Voice search is temporarily unavailable. Use typed search for now.");
      }
    },
    [onResolve, onFilter],
  );

  const submitRecording = useCallback(
    async (chunks: Blob[], mimeType: string) => {
      setPhase("processing");
      try {
        const blob = new Blob(chunks, { type: mimeType });
        const extension = mimeType.startsWith("audio/mp4") ? "mp4" : "webm";
        const form = new FormData();
        form.append(
          "file",
          new File([blob], `cellar-voice.${extension}`, { type: mimeType }),
        );
        const response = await fetch("/api/cellar/voice-resolve", {
          method: "POST",
          body: form,
        });
        const result = (await response.json()) as
          | VoiceResolveResponse
          | { error?: { message?: string } };
        if (!("kind" in result)) {
          const message =
            "error" in result ? result.error?.message : undefined;
          setNotice(
            message ??
              "Voice search couldn't finish. Try again or use typed search.",
          );
          return;
        }
        applyResult(result);
      } catch {
        setNotice("Voice search couldn't finish. Try again or use typed search.");
      } finally {
        setPhase("idle");
      }
    },
    [applyResult],
  );

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    setNotice(null);
    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType =
        MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const recordingType = recorder.mimeType || mimeType || "audio/webm";
        releaseRecording();
        void submitRecording(chunks, recordingType);
      };
      recorder.onerror = () => {
        releaseRecording();
        setPhase("idle");
        setNotice("Voice recording stopped unexpectedly. Try again.");
      };
      recorder.start();
      setPhase("recording");
      autoStopRef.current = setTimeout(stopRecording, AUTO_STOP_MS);
    } catch (error) {
      releaseRecording();
      setPhase("idle");
      setNotice(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission is needed for voice search."
          : "The microphone isn't available. Use typed search for now.",
      );
    }
  }, [releaseRecording, stopRecording, submitRecording]);

  if (!available) return null;

  const busy = phase === "requesting" || phase === "processing";
  const recording = phase === "recording";

  return (
    <>
      <button
        type="button"
        aria-label={recording ? "Stop voice search" : "Find a cellar wine by voice"}
        aria-pressed={recording}
        disabled={busy}
        onClick={recording ? stopRecording : startRecording}
        className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-pill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 md:hidden ${
          recording
            ? "bg-primary text-white"
            : "text-ink-soft hover:bg-surface/60 disabled:opacity-50"
        }`}
      >
        <Mic className="h-5 w-5" strokeWidth={2} aria-hidden />
        {recording && (
          <span
            className="absolute inset-0 animate-ping rounded-pill border border-accent/35"
            aria-hidden
          />
        )}
      </button>

      {notice && (
        <p
          role="status"
          aria-live="polite"
          className="glass fixed inset-x-md bottom-[88px] z-40 mx-auto max-w-[420px] rounded-lg px-md py-sm text-[14px] text-ink md:bottom-lg"
        >
          {notice}
        </p>
      )}

      {ambiguity && (
        <VoiceDisambiguationSheet
          transcript={ambiguity.transcript}
          candidates={ambiguity.candidates}
          onChoose={(candidate) => {
            setAmbiguity(null);
            setNotice(`Found ${candidate.producer} ${candidate.name}.`);
            onResolve(candidate.itemId);
          }}
          onClose={() => setAmbiguity(null)}
        />
      )}
    </>
  );
}

function VoiceDisambiguationSheet({
  transcript,
  candidates,
  onChoose,
  onClose,
}: {
  transcript: string;
  candidates: VoiceWineItem[];
  onChoose: (candidate: VoiceWineItem) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useFocusTrap({ containerRef: dialogRef, onEscape: onClose });

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop-click-to-dismiss is a mouse-only convenience; the dialog below already has full keyboard access via useFocusTrap (Escape + a visible Close button).
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim md:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full rounded-t-card bg-surface md:max-w-[440px] md:rounded-card md:border md:border-hairline"
      >
        <header className="flex items-start justify-between gap-sm border-b border-hairline px-md py-sm">
          <div>
            <h2 id={headingId} className="font-serif text-[19px] font-medium text-ink">
              Which cellar wine?
            </h2>
            <p className="mt-2xs text-[12px] text-grey">Heard: {transcript}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wine choices"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-grey hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="flex flex-col gap-xs px-md py-md">
          {candidates.map((candidate) => (
            <button
              key={candidate.itemId}
              type="button"
              onClick={() => onChoose(candidate)}
              className="min-h-11 rounded-card card-surface px-md py-sm text-left hover:bg-bridge-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="block text-[14px] font-medium text-ink">
                {candidate.producer} · {candidate.name}
              </span>
              {candidate.locations.length > 0 && (
                <span className="mt-2xs block text-[11.5px] text-grey">
                  {candidate.locations.join(", ")}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
