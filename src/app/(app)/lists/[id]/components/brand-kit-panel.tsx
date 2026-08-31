"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Loader2, Palette, Sparkles, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  BrandKitPaletteSchema,
  parseStoredProposals,
  parseStoredTheme,
  themeCssVariables,
  type BrandKitPalette,
  type MenuTheme,
} from "@/lib/branding/theme";

export type BrandKitView = {
  logoUrl: string | null;
  palette: BrandKitPalette | null;
  proposals: MenuTheme[];
};

type Status = { kind: "success" | "error"; message: string } | null;

export function BrandKitPanel({
  listId,
  initialBrandKit,
  initialTheme,
}: {
  listId: string;
  initialBrandKit: BrandKitView | null;
  initialTheme: unknown;
}) {
  const router = useRouter();
  const [logoUrl, setLogoUrl] = useState(initialBrandKit?.logoUrl ?? null);
  const [palette, setPalette] = useState(initialBrandKit?.palette ?? null);
  const [proposals, setProposals] = useState(initialBrandKit?.proposals ?? []);
  const [appliedTheme, setAppliedTheme] = useState(parseStoredTheme(initialTheme));
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  // LIST-05 — a kit can also come from the restaurant's own website.
  const [siteUrl, setSiteUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const busyRef = useRef(false);

  const applyBrandKit = useCallback(
    async (init: RequestInit, failure: string, success: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setUploading(true);
      setStatus(null);
      try {
        const response = await fetch("/api/brand-kit", { method: "POST", ...init });
        const payload = await response.json();
        if (!response.ok) throw new Error(errorMessage(payload, failure));
        const nextPalette = BrandKitPaletteSchema.parse(payload.brandKit.palette);
        setLogoUrl(payload.brandKit.logoUrl);
        setPalette(nextPalette);
        setProposals(parseStoredProposals(payload.brandKit.proposals));
        setStatus({ kind: "success", message: success });
      } catch (error) {
        setStatus({ kind: "error", message: messageOf(error) });
      } finally {
        busyRef.current = false;
        setUploading(false);
      }
    },
    [],
  );

  const uploadLogo = useCallback(
    (file: File) => {
      const form = new FormData();
      form.set("file", file);
      return applyBrandKit({ body: form }, "Logo upload failed.", "Palette extracted");
    },
    [applyBrandKit],
  );

  const importFromUrl = useCallback(
    (url: string) => {
      if (!url.trim()) {
        setStatus({ kind: "error", message: "Enter a website address." });
        return;
      }
      return applyBrandKit(
        {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
        },
        "Couldn't build a kit from that website.",
        "Palette read from the website",
      );
    },
    [applyBrandKit],
  );

  /**
   * Paste anywhere on the page: an image becomes the logo, a bare URL fills the
   * website field. Text pastes into a field the user is actually typing in are
   * left alone.
   */
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const image = [...(event.clipboardData?.files ?? [])].find((file) =>
        file.type.startsWith("image/"),
      );
      if (image) {
        event.preventDefault();
        void uploadLogo(image);
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
      if (/^https?:\/\/\S+$/i.test(text)) {
        event.preventDefault();
        setSiteUrl(text);
        void importFromUrl(text);
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [uploadLogo, importFromUrl]);

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const image = [...event.dataTransfer.files].find((file) =>
      file.type.startsWith("image/"),
    );
    if (image) {
      void uploadLogo(image);
      return;
    }
    const dropped = (
      event.dataTransfer.getData("text/uri-list") ||
      event.dataTransfer.getData("text/plain")
    ).trim();
    if (dropped) {
      setSiteUrl(dropped);
      void importFromUrl(dropped);
    }
  }

  async function generateThemes(currentTheme?: MenuTheme) {
    const instruction = currentTheme
      ? window.prompt("How should this theme change?")?.trim()
      : undefined;
    if (currentTheme && !instruction) return;
    setGenerating(true);
    setStatus(null);
    try {
      const response = await fetch("/api/brand-kit/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listId, instruction, currentTheme }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessage(payload, "Theme generation failed."));
      setProposals(parseStoredProposals(payload.proposals));
    } catch (error) {
      setStatus({ kind: "error", message: messageOf(error) });
    } finally {
      setGenerating(false);
    }
  }

  async function applyTheme(theme: MenuTheme) {
    setApplying(theme.name);
    setStatus(null);
    try {
      const response = await fetch(`/api/wine-lists/${listId}/theme`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessage(payload, "Theme could not be applied."));
      setAppliedTheme(theme);
      setStatus({ kind: "success", message: "Theme applied" });
      router.refresh();
    } catch (error) {
      setStatus({ kind: "error", message: messageOf(error) });
    } finally {
      setApplying(null);
    }
  }

  return (
    <section
      aria-label="Brand kit"
      className="mt-xl rounded-card card-surface p-md md:p-lg"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-col gap-md sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-xs">
            <Palette className="h-4 w-4 text-accent" aria-hidden />
            <h2 className="font-serif text-[20px] font-medium text-ink">Brand kit</h2>
          </div>
          <p className="mt-xs max-w-[576px] text-[13px] text-grey">
            Drop, paste or upload a logo — or give the restaurant&apos;s website
            address — then generate accessible menu themes.
          </p>
        </div>
        <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-xs rounded-pill border border-rule bg-surface px-md text-[13px] font-medium text-ink hover:bg-wash focus-ring">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
          {uploading ? "Extracting…" : "Upload logo"}
          <input
            aria-label="Upload logo"
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadLogo(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <form
        className="mt-md flex flex-col gap-sm sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void importFromUrl(siteUrl);
        }}
      >
        <div className="relative flex-1">
          <Link2
            className="pointer-events-none absolute left-sm top-1/2 h-4 w-4 -translate-y-1/2 text-grey"
            aria-hidden
          />
          <input
            type="url"
            inputMode="url"
            aria-label="Business website"
            placeholder="yourrestaurant.com"
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            className="h-11 w-full rounded-pill border border-edge bg-surface pl-xl pr-sm text-body-lg text-ink placeholder:text-grey focus:border-accent focus-ring md:text-control"
          />
        </div>
        <button
          type="submit"
          disabled={uploading}
          className="min-h-11 shrink-0 rounded-pill border border-rule bg-surface px-md text-body-sm font-medium text-ink hover:bg-wash focus-ring disabled:opacity-50"
        >
          Build from website
        </button>
      </form>

      <p
        data-brand-kit-dropzone
        className={cn(
          "mt-sm rounded-md border border-dashed px-sm py-xs text-ledger",
          dragging
            ? "border-accent bg-wash text-ink"
            : "border-rule text-grey",
        )}
      >
        {dragging
          ? "Drop the logo or link to build the kit."
          : "Drag a logo or a link here, or paste one anywhere on this page."}
      </p>

      {(logoUrl || palette) && (
        <div className="mt-md flex flex-wrap items-center gap-md rounded-md bg-wash p-sm">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Uploaded restaurant logo" className="h-12 w-24 object-contain" />
          )}
          <div className="flex flex-wrap gap-xs" aria-label="Extracted palette">
            {palette?.colors.map((colour) => (
              <span
                key={colour}
                data-palette-swatch
                title={colour}
                className="h-8 w-8 rounded-md border border-edge"
                style={{ backgroundColor: colour }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-md flex items-center gap-sm">
        <button
          type="button"
          disabled={!palette || generating}
          onClick={() => void generateThemes()}
          className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-seal-ink hover:bg-primary-hover focus-ring disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          {generating ? "Designing…" : "Generate themes"}
        </button>
        {status && (
          <p role="status" className={`text-[13px] ${status.kind === "error" ? "text-risk-ink" : "text-ready-ink"}`}>
            {status.message}
          </p>
        )}
      </div>

      {proposals.length > 0 && (
        <div className="mt-lg grid gap-md lg:grid-cols-3">
          {proposals.map((theme, index) => (
            <article
              key={index}
              className="overflow-hidden rounded-card shadow-card border border-rule"
              style={themeCssVariables(theme)}
            >
              <div className="bg-canvas p-md text-ink">
                <p className="text-caption uppercase text-grey">Wine list</p>
                <h3 className="mt-xs font-serif text-[20px]">{theme.name}</h3>
                <div className="mt-md border-t border-rule pt-sm">
                  <p className="font-serif text-[17px]">Estate Pinot Noir <span className="font-sans text-[12px] text-grey">2021</span></p>
                  <p className="mt-xs text-[12px] text-grey">Willamette Valley</p>
                </div>
              </div>
              <div className="flex items-center gap-xs border-t border-rule bg-surface p-sm">
                <button
                  type="button"
                  aria-label={`Apply ${theme.name}`}
                  disabled={applying !== null}
                  onClick={() => void applyTheme(theme)}
                  className="h-11 flex-1 rounded-pill bg-primary px-sm text-[12px] font-medium text-seal-ink focus-ring disabled:opacity-50"
                >
                  {applying === theme.name ? "Applying…" : appliedTheme?.name === theme.name ? "Applied" : "Apply"}
                </button>
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => void generateThemes(theme)}
                  className="h-11 rounded-pill border border-rule px-sm text-[12px] font-medium text-ink hover:bg-wash focus-ring disabled:opacity-50"
                >
                  Refine
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
