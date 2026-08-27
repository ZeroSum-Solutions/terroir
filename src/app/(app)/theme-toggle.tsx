"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "terroir-theme";

// Canvas colors for browser/PWA chrome — hand-synced with the DESIGN.md
// tokens, viewport.themeColor in layout.tsx, and its themeInitScript.
const THEME_COLORS = { light: "#f2ede3", dark: "#0d0c09" } as const;

type ThemeChoice = "light" | "dark" | "system";

function readStoredChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // storage unavailable (private mode) — fall through to system
  }
  return "system";
}

function applyChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // persisting is best-effort; the DOM attribute still applies this session
  }
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  syncBrowserChrome(choice);
}

/**
 * Next's viewport.themeColor metas only track the system scheme, so an
 * explicit choice would leave browser/PWA chrome (status bar, tab strip)
 * in the other mode's color. Force both metas to the chosen canvas; on
 * "system", restore each meta to its own media query's color.
 */
function syncBrowserChrome(choice: ThemeChoice) {
  const metas = document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  for (const meta of metas) {
    const systemColor = meta.media.includes("dark")
      ? THEME_COLORS.dark
      : THEME_COLORS.light;
    meta.content = choice === "system" ? systemColor : THEME_COLORS[choice];
  }
}

// Visible text labels, not icon guessing — the three unlabeled 28px icon
// buttons were undiscoverable (Kimi audit 2026-08-26). "Cellar" is the dark
// room's contract name; aria-labels stay descriptive for screen readers.
const OPTIONS: Array<{
  value: ThemeChoice;
  label: string;
  short: string;
}> = [
  { value: "light", label: "Light theme", short: "Light" },
  { value: "dark", label: "Dark theme", short: "Cellar" },
  { value: "system", label: "Match device theme", short: "Auto" },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  // The stored choice is only knowable on the client; render the neutral
  // default first so server and client markup agree.
  // The post-hydration correction is intentional and covered by the mount test.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setChoice(readStoredChoice()), []);

  return (
    <div role="group" aria-label="Theme" className="px-md py-sm">
      <span className="block text-[11px] font-medium uppercase tracking-[0.1em] text-grey">
        Theme
      </span>
      <div className="mt-xs flex items-stretch overflow-hidden rounded-pill border border-hairline">
        {OPTIONS.map(({ value, label, short }) => (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={choice === value}
            onClick={() => {
              setChoice(value);
              applyChoice(value);
            }}
            className={`min-h-10 flex-1 px-2xs text-[12px] font-medium transition-colors focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              choice === value
                ? "bg-surface-inverse text-on-inverse"
                : "text-grey hover:bg-bridge-surface hover:text-ink"
            }`}
          >
            {short}
          </button>
        ))}
      </div>
    </div>
  );
}
