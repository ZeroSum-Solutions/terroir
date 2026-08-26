"use client";

import { useEffect, useState } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";

const STORAGE_KEY = "terroir-theme";

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
          className={`flex h-8 w-8 items-center justify-center rounded-pill transition-colors focus-visible:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
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
