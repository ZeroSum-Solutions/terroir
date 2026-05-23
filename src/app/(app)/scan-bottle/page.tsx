"use client";

import {
  AlertTriangle,
  Camera,
  Check,
  Keyboard,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type MatchedWine = {
  id: string;
  producer: string;
  name: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  country: string | null;
};

type Phase =
  | "scanning"
  | "manual"
  | "matched"
  | "correcting"
  | "confirmed"
  | "error"
  | "no-camera";

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
    let detector: BarcodeDetector | null = null;

    if ("BarcodeDetector" in window) {
      try {
        detector = new (window as any).BarcodeDetector({
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
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Lookup failed (" + res.status + ")");
  }
  return (await res.json()) as MatchedWine;
}

async function searchWines(query: string): Promise<MatchedWine[]> {
  if (query.length < 2) return [];
  const url = "/api/wines?q=" + encodeURIComponent(query) + "&limit=8";
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as
    | { wines?: MatchedWine[] }
    | MatchedWine[];
  return Array.isArray(data) ? data : data.wines ?? [];
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
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
      })
      .catch(() => {
        setPhase((p) => (p === "scanning" ? "no-camera" : p));
      });
  }, []);

  const handleDecode = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPayload(trimmed);
    try {
      const matched = await lookupWine(trimmed);
      setWine(matched);
      setPhase("matched");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed.");
      setPhase("error");
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
    setSearchQuery(q);
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const results = await searchWines(q);
    setSearchResults(results);
    setSearching(false);
  }, []);

  const handleCorrectSelect = useCallback((w: MatchedWine) => {
    setWine(w);
    setPhase("matched");
    setError(null);
  }, []);

  const handleScanAgain = useCallback(() => {
    setPhase("scanning");
    setError(null);
    setWine(null);
    setPayload(null);
    setManualCode("");
  }, []);

  return (
    <div className="mx-auto max-w-[480px]">
      <header className="mb-lg md:mb-xl">
        <h1 className="font-serif text-[22px] text-ink md:text-[28px]">
          Scan Bottle
        </h1>
        <p className="mt-xs text-[14px] text-ink-muted md:text-[15px]">
          Scan a bottle&rsquo;s QR code to look up its wine.
        </p>
      </header>

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
              disabled={!manualCode.trim()}
              className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              <Search className="h-4 w-4" strokeWidth={2} />
              Look up wine
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
                setPhase("correcting");
                setSearchQuery("");
                setSearchResults([]);
              }}
              className="flex h-[44px] items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
            >
              <X className="h-4 w-4" strokeWidth={2} />
              Correct
            </button>
            <button
              type="button"
              onClick={() => setPhase("confirmed")}
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
                      {w.varietal && w.region ? " · " : ""}
                      {w.region}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!searching &&
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
            onClick={() => setPhase("matched")}
            className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm border border-border-strong bg-white text-[14px] font-medium text-ink hover:bg-surface-muted"
          >
            <X className="h-4 w-4" strokeWidth={2} />
            Cancel
          </button>
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
            </div>
            <button
              type="button"
              onClick={handleScanAgain}
              className="flex h-[44px] items-center justify-center gap-sm rounded-sm bg-accent px-xl text-[14px] font-medium text-white hover:bg-accent-hover"
            >
              <Camera className="h-4 w-4" strokeWidth={2} />
              Scan another bottle
            </button>
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
                Lookup failed
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
                onClick={handleScanAgain}
                className="flex h-[44px] w-full items-center justify-center gap-sm rounded-sm bg-accent text-[14px] font-medium text-white hover:bg-accent-hover"
              >
                <Camera className="h-4 w-4" strokeWidth={2} />
                Try again
              </button>
              {!payload && (
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
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
