"use client";

import {
  AlertTriangle,
  Camera,
  Check,
  Keyboard,
  List,
  MapPin,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
} from "@/lib/api/idempotency-client";
import { z } from "zod";

const MatchedWineSchema = z.object({
  id: z.string().uuid(),
  producer: z.string(),
  name: z.string(),
  vintage: z.number().int().nullable(),
  varietal: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable().default(null),
});
type MatchedWine = z.infer<typeof MatchedWineSchema>;

type SessionScan = {
  wine: MatchedWine;
  section: string;
  binLocation: string;
};

type Phase =
  | "scanning"
  | "manual"
  | "matched"
  | "correcting"
  | "location"
  | "confirmed"
  | "error"
  | "no-camera"
  | "summary";

type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};

const bottleLookupCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence(
    "terroir:bottle-scan-lookup",
  ),
});
const bottleConfirmCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence(
    "terroir:bottle-scan-confirm",
  ),
});

function useQrScanner(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  onDecode: (text: string) => Promise<boolean>,
  onUnavailable: () => void,
) {
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    let cancelled = false;
    // BarcodeDetector is an optional Chromium API not included in lib.dom.
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

    if (!detector || !navigator.mediaDevices?.getUserMedia) {
      onUnavailable();
      return;
    }

    const tick = async () => {
      if (cancelled) return;
      if (!videoRef.current) {
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
          const accepted = await onDecode(barcodes[0].rawValue);
          if (accepted || cancelled) return;
        }
      } catch {
        // expected
      }

      if (!cancelled) {
        rafRef.current = requestAnimationFrame(tick);
      }
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
      .catch(() => {
        if (!cancelled) onUnavailable();
      });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [active, videoRef, onDecode, onUnavailable]);
}

async function lookupWine(payload: string): Promise<MatchedWine> {
  const { response, data } = await bottleLookupCommands.json<unknown>({
    slot: "lookup",
    url: "/api/scan-bottle",
    method: "POST",
    json: { qr_payload: payload },
  });
  if (!response.ok) {
    throw new Error(
      readApiError(
        data,
        "Lookup failed (" + response.status + ")",
      ).message,
    );
  }
  const parsed = MatchedWineSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Lookup returned an invalid wine.");
  }
  return parsed.data;
}

async function searchWines(
  query: string,
  signal: AbortSignal,
): Promise<MatchedWine[]> {
  if (query.length < 2) return [];
  const url = "/api/wines/search?q=" + encodeURIComponent(query);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error("Wine search failed.");
  }
  const parsed = z.union([
    z.array(MatchedWineSchema),
    z.object({ wines: z.array(MatchedWineSchema).optional() }),
  ]).safeParse(await res.json());
  if (!parsed.success) {
    throw new Error("Wine search returned invalid results.");
  }
  return Array.isArray(parsed.data)
    ? parsed.data.slice(0, 8)
    : (parsed.data.wines ?? []).slice(0, 8);
}

export default function ScanBottlePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("scanning");
  const [error, setError] = useState<string | null>(null);
  const [wine, setWine] = useState<MatchedWine | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MatchedWine[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [section, setSection] = useState("");
  const [binLocation, setBinLocation] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const lookupBusyRef = useRef(false);
  const confirmBusyRef = useRef(false);
  const searchRequestRef = useRef(0);
  const searchTimerRef = useRef<number | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  // BND-112: batch scanning session state
  const [session, setSession] = useState<SessionScan[]>([]);

  const handleDecode = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed || lookupBusyRef.current) return false;
    lookupBusyRef.current = true;
    setLookingUp(true);
    setPayload(trimmed);
    try {
      const matched = await lookupWine(trimmed);
      setWine(matched);
      setPhase("matched");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed.");
      setPhase("error");
    } finally {
      lookupBusyRef.current = false;
      setLookingUp(false);
    }
    return true;
  }, []);

  const handleScannerUnavailable = useCallback(() => {
    setPhase((current) =>
      current === "scanning" ? "no-camera" : current,
    );
  }, []);

  useQrScanner(
    videoRef,
    phase === "scanning",
    handleDecode,
    handleScannerUnavailable,
  );

  const handleManualSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!manualCode.trim()) return;
      await handleDecode(manualCode);
    },
    [manualCode, handleDecode],
  );

  const resetCorrectionSearch = useCallback(() => {
    searchRequestRef.current += 1;
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setSearching(false);
  }, []);

  useEffect(
    () => () => {
      searchRequestRef.current += 1;
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
      }
      searchAbortRef.current?.abort();
    },
    [],
  );

  const handleCorrectSearch = useCallback((q: string) => {
    const requestId = ++searchRequestRef.current;
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSearchQuery(q);
    setSearchError(null);
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      const controller = new AbortController();
      searchAbortRef.current = controller;
      void searchWines(q, controller.signal)
        .then((results) => {
          if (requestId === searchRequestRef.current) {
            setSearchResults(results);
          }
        })
        .catch((searchFailure: unknown) => {
          if (
            requestId === searchRequestRef.current &&
            !(searchFailure instanceof DOMException &&
              searchFailure.name === "AbortError")
          ) {
            setSearchResults([]);
            setSearchError(
              searchFailure instanceof Error
                ? searchFailure.message
                : "Wine search failed.",
            );
          }
        })
        .finally(() => {
          if (requestId === searchRequestRef.current) {
            searchAbortRef.current = null;
            setSearching(false);
          }
        });
    }, 300);
  }, []);

  const handleCorrectSelect = useCallback(
    (w: MatchedWine) => {
      resetCorrectionSearch();
      setWine(w);
      setPhase("matched");
      setError(null);
    },
    [resetCorrectionSearch],
  );

  const handleScanAgain = useCallback(() => {
    setPhase("scanning");
    setError(null);
    setWine(null);
    setPayload(null);
    setManualCode("");
    setSection("");
    setBinLocation("");
    setConfirming(false);
  }, []);

  const handleConfirmLocation = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (
        !wine ||
        !section.trim() ||
        !binLocation.trim() ||
        confirmBusyRef.current
      ) {
        return;
      }
      confirmBusyRef.current = true;
      setConfirming(true);
      try {
        const { response, data } =
          await bottleConfirmCommands.json<unknown>({
            slot: "confirm",
            url: "/api/scan-bottle/confirm",
            method: "POST",
            json: {
              wine_id: wine.id,
              section: section.trim(),
              bin_location: binLocation.trim(),
            },
          });
        if (!response.ok) {
          throw new Error(
            readApiError(
              data,
              "Failed to record location.",
            ).message,
          );
        }
        // BND-112: add confirmed bottle to session
        setSession((prev) => [
          ...prev,
          { wine, section: section.trim(), binLocation: binLocation.trim() },
        ]);
        setPhase("confirmed");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to record bottle location.");
        setPhase("error");
      } finally {
        confirmBusyRef.current = false;
        setConfirming(false);
      }
    },
    [wine, section, binLocation],
  );

  const handleEndSession = useCallback(() => {
    setPhase("summary");
  }, []);

  const handleNewSession = useCallback(() => {
    setSession([]);
    setPhase("scanning");
    setError(null);
    setWine(null);
    setPayload(null);
    setManualCode("");
    setSection("");
    setBinLocation("");
    setConfirming(false);
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
            <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
              Scan a bottle&rsquo;s QR code to look up its wine.
            </p>
          </div>
          {showSessionBadge && phase !== "summary" && (
            <div className="flex items-center gap-sm">
              <span className="inline-flex items-center gap-xs rounded-pill bg-accent px-sm py-xs text-[13px] font-semibold text-white">
                <List className="h-3.5 w-3.5" strokeWidth={2.5} />
                {session.length} scanned
              </span>
              <button
                type="button"
                onClick={handleEndSession}
                className="flex h-[36px] items-center gap-xs rounded-sm border border-border-strong bg-white px-sm text-[12px] font-medium text-ink hover:bg-surface-muted transition-colors"
              >
                End session
              </button>
            </div>
          )}
        </div>
      </header>

      {/* BND-112: Summary view showing all scanned bottles */}
      {phase === "summary" && (
        <div className="space-y-md">
          <div className="rounded-md border border-border bg-white p-md md:p-lg">
            <h2 className="font-serif text-[18px] text-ink">Session summary</h2>
            <p className="mt-xs text-[13px] text-ink-muted">
              {session.length} bottle{session.length !== 1 ? "s" : ""} scanned
              in this session.
            </p>
          </div>

          {session.length > 0 ? (
            <ul className="divide-y divide-border rounded-md border border-border bg-white">
              {session.map((scan, i) => (
                <li key={i} className="px-md py-md">
                  <div className="flex items-start justify-between gap-sm">
                    <div className="min-w-0">
                      <p className="font-serif text-[15px] font-medium text-ink truncate">
                        {scan.wine.producer}
                      </p>
                      <p className="text-[14px] text-ink-muted truncate">
                        {scan.wine.name}
                        {scan.wine.vintage ? " (" + scan.wine.vintage + ")" : ""}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-pill bg-surface-muted px-sm py-2xs text-[11px] font-medium text-ink-subtle tabular">
                      #{i + 1}
                    </span>
                  </div>
                  <p className="mt-xs inline-flex items-center gap-xs text-[12px] text-ink-subtle">
                    <MapPin className="h-3 w-3" strokeWidth={2} />
                    {scan.section}{" "}
                    <span aria-hidden>&middot;</span>{" "}
                    {scan.binLocation}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-md rounded-md border border-border bg-white px-lg py-2xl text-center">
              <p className="text-[14px] text-ink-muted">
                No bottles were scanned in this session.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={handleNewSession}
            className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover"
          >
            <Camera className="h-4 w-4" strokeWidth={2} />
            Start new session
          </button>
        </div>
      )}

      {phase === "scanning" && (
        <div className="space-y-md">
          <div className="relative overflow-hidden rounded-md border-2 border-border bg-surface-inverse">
            <div className="relative pb-[75%]">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-48 w-48 rounded-md border-2 border-accent/60 md:h-56 md:w-56" />
              </div>
            </div>
            <div className="absolute bottom-md left-1/2 -translate-x-1/2">
              <span className="inline-flex items-center gap-sm rounded-sm bg-surface-inverse/80 px-md py-sm text-[13px] font-medium text-white backdrop-blur-sm">
                <ScanLine className="h-4 w-4 animate-pulse" strokeWidth={2} />
                Point camera at QR code
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setPhase("manual");
              setError(null);
            }}
            className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
          >
            <Keyboard className="h-4 w-4" strokeWidth={2} />
            Enter code manually
          </button>
        </div>
      )}

      {phase === "no-camera" && (
        <div className="space-y-md">
          <div className="flex flex-col items-center gap-md rounded-md border border-border bg-white px-lg py-2xl text-center">
            <div className="rounded-full bg-surface-muted p-lg">
              <Camera className="h-8 w-8 text-ink-subtle" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-[15px] font-medium text-ink">
                Camera not available
              </p>
              <p className="mt-xs text-[13px] text-ink-muted">
                Enter the bottle&rsquo;s wine code manually.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPhase("manual")}
              className="flex h-[44px] items-center justify-center gap-sm rounded-sm bg-accent px-lg text-[14px] font-medium text-white hover:bg-accent-hover"
            >
              <Keyboard className="h-4 w-4" strokeWidth={2} />
              Enter code
            </button>
          </div>
        </div>
      )}

      {phase === "manual" && (
        <div className="space-y-md">
          <form onSubmit={handleManualSubmit} className="space-y-md">
            <div className="rounded-md border border-border bg-white p-md md:p-lg">
              <label
                htmlFor="manual-code"
                className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"
              >
                Wine ID or QR code
              </label>
              <input
                id="manual-code"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoFocus
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="Enter the code from the bottle label"
                className="w-full rounded-sm border border-border bg-white px-md py-sm font-mono text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
              />
              <p className="mt-xs text-[12px] text-ink-subtle">
                The code is printed below the QR code on the bottle label.
              </p>
            </div>
            <button
              type="submit"
              disabled={!manualCode.trim() || lookingUp}
              className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              <Search className="h-4 w-4" strokeWidth={2} />
              {lookingUp ? "Looking up..." : "Look up wine"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => {
              setPhase("scanning");
              setError(null);
            }}
            className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
          >
            <Camera className="h-4 w-4" strokeWidth={2} />
            Use camera instead
          </button>
        </div>
      )}

      {phase === "matched" && wine && (
        <div className="space-y-md">
          <div className="rounded-md border border-border bg-white p-md md:p-lg">
            <div className="mb-md flex items-start justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Matched wine
              </span>
              <span className="rounded-pill bg-success-soft px-sm py-2xs text-[12px] font-medium text-success">
                Match found
              </span>
            </div>
            <h2 className="font-serif text-[20px] text-ink md:text-[22px]">
              {wine.producer}
            </h2>
            <p className="mt-xs font-serif text-[18px] text-ink md:text-[20px]">
              {wine.name}
            </p>
            <dl className="mt-md grid grid-cols-2 gap-x-md gap-y-sm text-[13px]">
              {wine.vintage && (
                <>
                  <dt className="text-ink-subtle">Vintage</dt>
                  <dd className="tabular text-ink">{wine.vintage}</dd>
                </>
              )}
              {wine.varietal && (
                <>
                  <dt className="text-ink-subtle">Varietal</dt>
                  <dd className="text-ink">{wine.varietal}</dd>
                </>
              )}
              {wine.region && (
                <>
                  <dt className="text-ink-subtle">Region</dt>
                  <dd className="text-ink">{wine.region}</dd>
                </>
              )}
              {wine.country && (
                <>
                  <dt className="text-ink-subtle">Country</dt>
                  <dd className="text-ink">{wine.country}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="grid grid-cols-2 gap-sm">
            <button
              type="button"
              onClick={() => {
                resetCorrectionSearch();
                setPhase("correcting");
              }}
              className="flex h-[44px] items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
            >
              <X className="h-4 w-4" strokeWidth={2} />
              Correct
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("location");
                setSection("");
                setBinLocation("");
              }}
              className="flex h-[44px] items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover"
            >
              <Check className="h-4 w-4" strokeWidth={2} />
              Confirm
            </button>
          </div>
        </div>
      )}

      {phase === "correcting" && (
        <div className="space-y-md">
          <div className="rounded-md border border-border bg-white p-md md:p-lg">
            <label
              htmlFor="correct-search"
              className="mb-xs block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle"
            >
              Search for the correct wine
            </label>
            <input
              id="correct-search"
              type="search"
              inputMode="search"
              autoComplete="off"
              autoFocus
              value={searchQuery}
              onChange={(e) => handleCorrectSearch(e.target.value)}
              placeholder="Search by producer, name, or vintage..."
              className="w-full rounded-sm border border-border bg-white px-md py-sm text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
            />
          </div>

          {searching && (
            <p className="px-md text-[13px] text-ink-muted">Searching...</p>
          )}

          {!searching && searchError && (
            <p className="px-md text-[13px] text-danger">
              {searchError}
            </p>
          )}

          {!searching && searchResults.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border bg-white">
              {searchResults.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => handleCorrectSelect(w)}
                    className="flex w-full items-start gap-md px-md py-md text-left hover:bg-surface-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-serif text-[15px] font-medium text-ink">
                        {w.producer}
                      </p>
                      <p className="truncate text-[14px] text-ink-muted">
                        {w.name}
                        {w.vintage ? ", " + w.vintage : ""}
                      </p>
                    </div>
                    <span className="mt-0.5 shrink-0 text-[11px] text-ink-subtle">
                      {w.varietal}
                      {w.varietal && w.region ? " . " : ""}
                      {w.region}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!searching &&
            !searchError &&
            searchQuery.length >= 2 &&
            searchResults.length === 0 && (
              <p className="px-md text-[13px] text-ink-muted">
                No wines found for &ldquo;
                {searchQuery}
                &rdquo;.
              </p>
            )}

          <button
            type="button"
            onClick={() => {
              resetCorrectionSearch();
              setPhase("matched");
            }}
            className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
          >
            <X className="h-4 w-4" strokeWidth={2} />
            Cancel
          </button>
        </div>
      )}

      {phase === "location" && wine && (
        <div className="space-y-md">
          <div className="rounded-md border border-border bg-white p-md md:p-lg">
            <div className="mb-md flex items-start justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Bottle location
              </span>
              <span className="rounded-pill bg-accent-soft px-sm py-2xs text-[12px] font-medium text-accent">
                {wine.producer} {wine.name}
                {wine.vintage ? " " + wine.vintage : ""}
              </span>
            </div>
            <form onSubmit={handleConfirmLocation} className="space-y-md">
              <div>
                <label
                  htmlFor="bottle-section"
                  className="mb-xs block text-[13px] font-medium text-ink"
                >
                  Section
                </label>
                <input
                  id="bottle-section"
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={section}
                  onChange={(e) => setSection(e.target.value)}
                  placeholder='e.g. "Red Room", "Main Cellar"'
                  className="w-full rounded-sm border border-border bg-white px-md py-sm text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                />
              </div>
              <div>
                <label
                  htmlFor="bottle-bin"
                  className="mb-xs block text-[13px] font-medium text-ink"
                >
                  Bin location
                </label>
                <input
                  id="bottle-bin"
                  type="text"
                  autoComplete="off"
                  value={binLocation}
                  onChange={(e) => setBinLocation(e.target.value)}
                  placeholder='e.g. "A-12", "Shelf 3, Row 5"'
                  className="w-full rounded-sm border border-border bg-white px-md py-sm text-[14px] text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft"
                />
              </div>
              <div className="grid grid-cols-2 gap-sm">
                <button
                  type="button"
                  onClick={() => setPhase("matched")}
                  className="flex h-[44px] items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                  Back
                </button>
                <button
                  type="submit"
                  disabled={!section.trim() || !binLocation.trim() || confirming}
                  className="flex h-[44px] items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  <Check className="h-4 w-4" strokeWidth={2} />
                  {confirming ? "Saving..." : "Save location"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {phase === "confirmed" && wine && (
        <div className="space-y-md">
          <div className="flex flex-col items-center gap-lg rounded-md border border-success/30 bg-success-soft/40 px-lg py-2xl text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success">
              <Check className="h-7 w-7 text-white" strokeWidth={2.5} />
            </div>
            <div>
              <p className="text-[17px] font-medium text-ink">
                Bottle confirmed
              </p>
              <p className="mt-xs text-[14px] text-ink-muted">
                <span className="font-serif">{wine.producer}</span>{" "}
                {wine.name}
                {wine.vintage ? " (" + wine.vintage + ")" : ""}
              </p>
              {(section || binLocation) && (
                <p className="mt-sm inline-flex items-center gap-xs text-[12px] text-ink-subtle">
                  <MapPin className="h-3 w-3" strokeWidth={2} />
                  {section && <span>{section}</span>}
                  {section && binLocation && <span>&middot;</span>}
                  {binLocation && <span>{binLocation}</span>}
                </p>
              )}
            </div>
            <div className="flex w-full flex-col gap-sm">
              <button
                type="button"
                onClick={handleScanAgain}
                className="flex h-[44px] items-center justify-center gap-sm rounded-sm bg-accent px-xl text-[14px] font-medium text-white hover:bg-accent-hover"
              >
                <Camera className="h-4 w-4" strokeWidth={2} />
                Scan another bottle
              </button>
              {session.length >= 1 && (
                <button
                  type="button"
                  onClick={handleEndSession}
                  className="flex h-[44px] items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
                >
                  <List className="h-4 w-4" strokeWidth={2} />
                  End session ({session.length} scanned)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-md">
          <div className="flex flex-col items-center gap-md rounded-md border border-danger/20 bg-white px-lg py-2xl text-center">
            <div className="rounded-full bg-surface-muted p-lg">
              <AlertTriangle
                className="h-8 w-8 text-danger"
                strokeWidth={1.5}
              />
            </div>
            <div>
              <p className="text-[15px] font-medium text-ink">
                {wine ? "Save failed" : "Lookup failed"}
              </p>
              <p className="mt-xs text-[13px] text-ink-muted">{error}</p>
              {payload && (
                <p className="mt-sm font-mono text-[12px] text-ink-subtle">
                  Code: {payload}
                </p>
              )}
            </div>
            <div className="flex w-full flex-col gap-sm">
              <button
                type="button"
                onClick={() => {
                  if (wine && section.trim() && binLocation.trim()) {
                    void handleConfirmLocation();
                  } else if (payload) {
                    void handleDecode(payload);
                  } else {
                    handleScanAgain();
                  }
                }}
                disabled={lookingUp || confirming}
                className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                <Camera className="h-4 w-4" strokeWidth={2} />
                {lookingUp || confirming ? "Retrying..." : "Try again"}
              </button>
              {wine ? (
                <button
                  type="button"
                  onClick={() => {
                    setPhase("location");
                    setError(null);
                  }}
                  className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
                >
                  <MapPin className="h-4 w-4" strokeWidth={2} />
                  Edit location
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setPhase("manual");
                    setError(null);
                  }}
                  className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
                >
                  <Keyboard className="h-4 w-4" strokeWidth={2} />
                  {payload ? "Enter different code" : "Enter code manually"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
