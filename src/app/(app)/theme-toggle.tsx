"use client";

import { useEffect, useState } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";

const STORAGE_KEY = "terroir-theme";

// Canvas colors for browser/PWA chrome — hand-synced with the DESIGN.md
// tokens, viewport.themeColor in layout.tsx, and its themeInitScript.
const THEME_COLORS = { light: "#f2ede3", dark: "#1d1512" } as const;

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

const OPTIONS: Array<{
  value: ThemeChoice;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "system", label: "Match device theme", Icon: SunMoon },
];

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  // The stored choice is only knowable on the client; render the neutral
  // default first so server and client markup agree.
  // The post-hydration correction is intentional and covered by the mount test.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setChoice(readStoredChoice()), []);

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-2xs px-md py-sm"
    >
      <span className="mr-auto text-[14px] text-ink">Theme</span>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
            applyChoice(value);
          }}
          className={`flex h-8 w-8 items-center justify-center rounded-pill transition-colors focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            choice === value
              ? "bg-surface-inverse text-on-inverse"
              : "text-grey hover:bg-bridge-surface hover:text-ink"
          }`}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
