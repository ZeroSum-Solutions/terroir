"use client";

import { List } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { readApiError } from "@/lib/api/client-error";
import { bottleScanReducer, initialBottleScanState, type MatchedWine } from "./scan-bottle-state";
import { ScanningView } from "./views/scanning-view";
import { NoCameraView } from "./views/no-camera-view";
import { ManualView } from "./views/manual-view";
import { MatchedView } from "./views/matched-view";
import { CorrectingView } from "./views/correcting-view";
import { LocationView } from "./views/location-view";
import { ConfirmedView } from "./views/confirmed-view";
import { ErrorView } from "./views/error-view";
import { SummaryView } from "./views/summary-view";

type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};

function useQrScanner(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  onDecode: (text: string) => void,
) {
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    let cancelled = false;
    // BarcodeDetector is a browser API not in lib.dom yet (Safari/Chrome only).
    let detector: { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } | null = null;

    if ("BarcodeDetector" in window) {
      try {
        const BarcodeDetector =
          (window as Window & { BarcodeDetector: BarcodeDetectorConstructor })
            .BarcodeDetector;
        detector = new BarcodeDetector({
          formats: ["qr_code"],
        });
      } catch {
        // not supported
      }
    }

    const tick = async () => {
      if (cancelled || !videoRef.current || !detector) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const video = videoRef.current;
      if (video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      try {
        const barcodes = await detector.detect(video);
        if (barcodes.length > 0 && !cancelled) {
          onDecode(barcodes[0].rawValue);
          return;
        }
      } catch {
        // expected
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: "environment", width: { ideal: 640 } },
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [active, videoRef, onDecode]);
}

async function lookupWine(payload: string): Promise<MatchedWine> {
  const res = await fetch("/api/scan-bottle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qr_payload: payload }),
  });
  if (!res.ok) {
    throw new Error(
      readApiError(
        await res.json().catch(() => null),
        "Lookup failed (" + res.status + ")",
      ).message,
    );
  }
  return (await res.json()) as MatchedWine;
}

/**
 * `/api/wines/search` answers with a bare array on the projection in
 * src/app/api/wines/search/route.ts — which does not include `country`, so a
 * corrected wine carries none until it is re-read from the wine record.
 */
type WineSearchResult = Omit<MatchedWine, "country">;

async function searchWines(query: string): Promise<MatchedWine[]> {
  if (query.length < 2) return [];
  const res = await fetch("/api/wines/search?q=" + encodeURIComponent(query));
  if (!res.ok) {
    // A swallowed non-ok here is indistinguishable from "no such wine": this
    // call used to hit a route that does not exist and reported an empty
    // cellar for every query, silently, for as long as it was wrong.
    throw new Error(
      readApiError(
        await res.json().catch(() => null),
        "Search failed (" + res.status + ")",
      ).message,
    );
  }
  const wines = (await res.json()) as WineSearchResult[];
  return wines.map((wine) => ({ ...wine, country: null }));
}

export default function ScanBottlePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, dispatch] = useReducer(bottleScanReducer, initialBottleScanState);
  const { phase, error, wine, payload, manualCode, searchQuery, searchResults, searching, searchError, section, binLocation, confirming, session } = state;

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      })
      .catch(() => {
        dispatch({ type: "camera-unavailable" });
      });
  }, []);

  const handleDecode = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatch({ type: "decode-started", payload: trimmed });
    try {
      const matched = await lookupWine(trimmed);
      dispatch({ type: "lookup-succeeded", wine: matched });
    } catch (err) {
      dispatch({
        type: "lookup-failed",
        message: err instanceof Error ? err.message : "Lookup failed.",
      });
    }
  }, []);

  useQrScanner(videoRef, phase === "scanning", handleDecode);

  const handleManualSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!manualCode.trim()) return;
      await handleDecode(manualCode);
    },
    [manualCode, handleDecode],
  );

  const handleCorrectSearch = useCallback(async (q: string) => {
    dispatch({ type: "correct-search-query-changed", query: q });
    if (q.length < 2) {
      return;
    }
    dispatch({ type: "correct-search-started" });
    try {
      const results = await searchWines(q);
      dispatch({ type: "correct-search-completed", results });
    } catch (err) {
      dispatch({
        type: "correct-search-failed",
        message: err instanceof Error ? err.message : "Search failed.",
      });
    }
  }, []);

  const handleCorrectSelect = useCallback((w: MatchedWine) => {
    dispatch({ type: "correct-wine-selected", wine: w });
  }, []);

  const handleScanAgain = useCallback(() => {
    dispatch({ type: "scan-again" });
  }, []);

  const handleConfirmLocation = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!wine || !section.trim() || !binLocation.trim()) return;
      dispatch({ type: "location-confirm-started" });
      try {
        const res = await fetch("/api/scan-bottle/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wine_id: wine.id,
            section: section.trim(),
            bin_location: binLocation.trim(),
          }),
        });
        if (!res.ok) {
          throw new Error(
            readApiError(
              await res.json().catch(() => null),
              "Failed to record location.",
            ).message,
          );
        }
        // BND-112: add confirmed bottle to session
        dispatch({
          type: "location-confirmed",
          scan: { wine, section: section.trim(), binLocation: binLocation.trim() },
        });
      } catch (err) {
        dispatch({
          type: "location-confirm-failed",
          message: err instanceof Error ? err.message : "Failed to record bottle location.",
        });
      }
    },
    [wine, section, binLocation],
  );

  const handleEndSession = useCallback(() => {
    dispatch({ type: "session-ended" });
  }, []);

  const handleNewSession = useCallback(() => {
    dispatch({ type: "new-session-started" });
  }, []);

  const showSessionBadge = session.length > 0;

  return (
    <div className="mx-auto max-w-[480px]">
      <header className="mb-lg md:mb-xl">
        <div className="flex items-center justify-between gap-sm">
          <div>
            <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
              Scan Bottle
            </h1>
            <p className="mt-xs text-[14px] text-grey md:text-[15px]">
              Scan a bottle&rsquo;s QR code to look up its wine.
            </p>
          </div>
          {showSessionBadge && phase !== "summary" && (
            <div className="flex items-center gap-sm">
              <span className="inline-flex items-center gap-xs rounded-pill bg-surface-sunken px-sm py-xs text-[13px] font-medium text-ink-soft">
                <List className="h-3.5 w-3.5" strokeWidth={2.5} />
                <span className="tabular">{session.length}</span> scanned
              </span>
              <button
                type="button"
                onClick={handleEndSession}
                className="flex h-11 items-center gap-xs rounded-pill border border-edge bg-surface px-sm text-[12px] font-medium text-ink hover:bg-wash transition-colors focus-ring"
              >
                End session
              </button>
            </div>
          )}
        </div>
      </header>

      {/* BND-112: Summary view showing all scanned bottles */}
      {phase === "summary" && (
        <SummaryView session={session} onNewSession={handleNewSession} />
      )}

      {phase === "scanning" && (
        <ScanningView
          videoRef={videoRef}
          onEnterCode={() => dispatch({ type: "manual-entry-opened" })}
        />
      )}

      {phase === "no-camera" && (
        <NoCameraView onEnterCode={() => dispatch({ type: "no-camera-manual-entry" })} />
      )}

      {phase === "manual" && (
        <ManualView
          manualCode={manualCode}
          onManualCodeChange={(value) => dispatch({ type: "manual-code-changed", value })}
          onSubmit={handleManualSubmit}
          onUseCamera={() => dispatch({ type: "camera-entry-opened" })}
        />
      )}

      {phase === "matched" && wine && (
        <MatchedView
          wine={wine}
          onCorrect={() => dispatch({ type: "correction-started" })}
          onConfirm={() => dispatch({ type: "location-entry-started" })}
        />
      )}

      {phase === "correcting" && (
        <CorrectingView
          searchQuery={searchQuery}
          onSearchChange={handleCorrectSearch}
          searching={searching}
          searchResults={searchResults}
          searchError={searchError}
          onSelect={handleCorrectSelect}
          onCancel={() => dispatch({ type: "correction-cancelled" })}
        />
      )}

      {phase === "location" && wine && (
        <LocationView
          wine={wine}
          section={section}
          binLocation={binLocation}
          onSectionChange={(value) => dispatch({ type: "section-changed", value })}
          onBinLocationChange={(value) => dispatch({ type: "bin-location-changed", value })}
          onSubmit={handleConfirmLocation}
          onBack={() => dispatch({ type: "correction-cancelled" })}
          confirming={confirming}
        />
      )}

      {phase === "confirmed" && wine && (
        <ConfirmedView
          wine={wine}
          section={section}
          binLocation={binLocation}
          sessionCount={session.length}
          onScanAgain={handleScanAgain}
          onEndSession={handleEndSession}
        />
      )}

      {phase === "error" && (
        <ErrorView
          error={error}
          payload={payload}
          onTryAgain={handleScanAgain}
          onManualEntry={() => dispatch({ type: "manual-entry-opened" })}
        />
      )}
    </div>
  );
}
