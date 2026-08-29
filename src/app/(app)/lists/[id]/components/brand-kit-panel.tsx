"use client";

import { useState } from "react";
import { Loader2, Palette, Sparkles, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
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

  async function uploadLogo(file: File) {
    setUploading(true);
    setStatus(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/brand-kit", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(errorMessage(payload, "Logo upload failed."));
      const nextPalette = BrandKitPaletteSchema.parse(payload.brandKit.palette);
      setLogoUrl(payload.brandKit.logoUrl);
      setPalette(nextPalette);
      const stored = parseStoredProposals(payload.brandKit.proposals);
      setProposals(stored);
      setStatus({ kind: "success", message: "Palette extracted" });
    } catch (error) {
      setStatus({ kind: "error", message: messageOf(error) });
    } finally {
      setUploading(false);
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
    >
      <div className="flex flex-col gap-md sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-xs">
            <Palette className="h-4 w-4 text-accent" aria-hidden />
            <h2 className="font-serif text-[20px] font-medium text-ink">Brand kit</h2>
          </div>
          <p className="mt-xs max-w-[576px] text-[13px] text-ink-muted">
            Upload a logo, extract its palette, then generate accessible menu themes.
          </p>
        </div>
        <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-xs rounded-pill border border-hairline bg-surface px-md text-[13px] font-medium text-ink hover:bg-bridge-surface focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/25">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
          {uploading ? "Extracting…" : "Upload logo"}
          <input
            aria-label="Upload logo"
            className="sr-only"
            type="file"
            accept="image/png"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadLogo(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      {(logoUrl || palette) && (
        <div className="mt-md flex flex-wrap items-center gap-md rounded-md bg-bridge-surface p-sm">
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
                className="h-8 w-8 rounded-md border border-ink/10"
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
          className="inline-flex min-h-11 items-center gap-xs rounded-pill bg-primary px-md text-[13px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
          {generating ? "Designing…" : "Generate themes"}
        </button>
        {status && (
          <p role="status" className={`text-[13px] ${status.kind === "error" ? "text-accent" : "text-sage-ink"}`}>
            {status.message}
          </p>
        )}
      </div>

      {proposals.length > 0 && (
        <div className="mt-lg grid gap-md lg:grid-cols-3">
          {proposals.map((theme, index) => (
            <article
              key={index}
              className="overflow-hidden rounded-card shadow-card border border-hairline"
              style={themeCssVariables(theme)}
            >
              <div className="bg-canvas p-md text-ink">
                <p className="text-caption uppercase text-grey">Wine list</p>
                <h3 className="mt-xs font-serif text-[20px]">{theme.name}</h3>
                <div className="mt-md border-t border-hairline pt-sm">
                  <p className="font-serif text-[17px]">Estate Pinot Noir <span className="font-sans text-[12px] text-ink-muted">2021</span></p>
                  <p className="mt-xs text-[12px] text-ink-muted">Willamette Valley</p>
                </div>
              </div>
              <div className="flex items-center gap-xs border-t border-hairline bg-surface p-sm">
                <button
                  type="button"
                  aria-label={`Apply ${theme.name}`}
                  disabled={applying !== null}
                  onClick={() => void applyTheme(theme)}
                  className="h-11 flex-1 rounded-pill bg-primary px-sm text-[12px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {applying === theme.name ? "Applying…" : appliedTheme?.name === theme.name ? "Applied" : "Apply"}
                </button>
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => void generateThemes(theme)}
                  className="h-11 rounded-pill border border-hairline px-sm text-[12px] font-medium text-ink hover:bg-bridge-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50"
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
