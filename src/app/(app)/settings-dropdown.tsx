"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Building2,
  Check,
  DollarSign,
  Loader2,
  LogOut,
  Settings,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/api/client-error";
import {
  createIdempotentCommandStore,
  createSessionCommandPersistence,
  readApiErrorCode,
  shouldRetainIdempotencyKey,
} from "@/lib/api/idempotency-client";

type RestaurantOption = {
  restaurantId: string;
  restaurantName: string;
  role: "owner" | "manager" | "staff";
};

const restaurantSwitchCommands = createIdempotentCommandStore({
  persistence: createSessionCommandPersistence(
    "terroir:restaurant-switch",
  ),
});
const PENDING_SWITCH_KEY = "terroir:restaurant-switch:pending";

function storePendingSwitch(restaurantId: string): void {
  try {
    sessionStorage.setItem(
      PENDING_SWITCH_KEY,
      JSON.stringify({ restaurantId }),
    );
  } catch {
    // The command store still owns the retry key for this mount.
  }
}

function loadPendingSwitch(): string | null {
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(PENDING_SWITCH_KEY) ?? "null",
    ) as { restaurantId?: unknown } | null;
    return typeof parsed?.restaurantId === "string"
      ? parsed.restaurantId
      : null;
  } catch {
    return null;
  }
}

function clearPendingSwitch(): void {
  try {
    sessionStorage.removeItem(PENDING_SWITCH_KEY);
  } catch {
    // Session storage availability cannot change server-side state.
  }
}

export function SettingsDropdown({
  activeRestaurantId,
  activeRestaurantName,
  activeRole,
  restaurants,
}: {
  activeRestaurantId: string;
  activeRestaurantName: string;
  activeRole: "owner" | "manager" | "staff";
  restaurants: readonly RestaurantOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchingRef = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);
  const restaurantItemCount = restaurants.length > 1 ? restaurants.length : 0;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      const items = itemsRef.current.filter(
        (item): item is HTMLElement =>
          item !== null &&
          !(
            item instanceof HTMLButtonElement &&
            item.disabled
          ),
      );
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = activeIndex < items.length - 1 ? activeIndex + 1 : 0;
        setActiveIndex(next);
        items[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
        setActiveIndex(prev);
        items[prev]?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, close, activeIndex]);

  useEffect(() => {
    const pendingRestaurantId = loadPendingSwitch();
    if (!pendingRestaurantId) return;
    if (pendingRestaurantId !== activeRestaurantId) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setSwitchError(
            "The previous switch could not be confirmed. Retry the same restaurant.",
          );
        }
      });
      return () => {
        cancelled = true;
      };
    }

    try {
      restaurantSwitchCommands.abandon("switch");
    } catch {
      // An in-flight command will perform its own success cleanup.
      return;
    }
    clearPendingSwitch();
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setSwitchError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeRestaurantId]);

  async function switchRestaurant(restaurantId: string) {
    if (
      restaurantId === activeRestaurantId ||
      switchingRef.current
    ) {
      return;
    }

    switchingRef.current = true;
    setSwitchingTo(restaurantId);
    setSwitchError(null);
    storePendingSwitch(restaurantId);
    try {
      const { response, data } =
        await restaurantSwitchCommands.json<unknown>({
          slot: "switch",
          url: `/api/restaurant/${restaurantId}`,
          method: "PUT",
        });
      if (!response.ok) {
        const error = readApiError(
          data,
          `Failed to switch restaurant (${response.status}).`,
        );
        setSwitchError(error.message);
        if (
          shouldRetainIdempotencyKey(
            response.status,
            readApiErrorCode(data),
          )
        ) {
          router.refresh();
        } else {
          clearPendingSwitch();
        }
        return;
      }

      clearPendingSwitch();
      setOpen(false);
      router.refresh();
    } catch {
      // A transport or response-parse failure cannot prove whether the signed
      // cookie reached the browser. Keep the same key and reconcile on refresh.
      setSwitchError(
        "The restaurant switch could not be confirmed. Refresh or retry.",
      );
      router.refresh();
    } finally {
      switchingRef.current = false;
      setSwitchingTo(null);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="true"
        className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink md:h-auto md:w-auto md:border md:border-border-strong md:bg-white md:px-md md:py-sm"
      >
        <Settings className="h-5 w-5 md:h-4 md:w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-xs w-[240px] rounded-md border border-border bg-surface shadow-lg" role="menu">
          <div className="flex flex-col py-xs">
            <div className="px-md py-sm">
              <p className="truncate text-[14px] font-medium text-ink">
                {activeRestaurantName}
              </p>
              <p className="mt-2xs text-[12px] capitalize text-ink-muted">
                {activeRole}
              </p>
            </div>
            {restaurants.length > 1 && (
              <>
                <div
                  className="mx-md my-xs border-t border-border"
                  role="separator"
                />
                <p className="px-md pb-2xs text-[11px] uppercase tracking-wide text-ink-muted">
                  Switch restaurant
                </p>
                {restaurants.map((restaurant, index) => {
                  const isActive =
                    restaurant.restaurantId === activeRestaurantId;
                  const isSwitching =
                    restaurant.restaurantId === switchingTo;
                  return (
                    <button
                      key={restaurant.restaurantId}
                      ref={(element) => {
                        itemsRef.current[index] = element;
                      }}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={isActive || switchingTo !== null}
                      onClick={() =>
                        void switchRestaurant(
                          restaurant.restaurantId,
                        )
                      }
                      className="flex w-full items-center gap-sm px-md py-sm text-left text-[14px] text-ink transition-colors hover:bg-surface-muted disabled:cursor-default disabled:opacity-60"
                    >
                      {isSwitching ? (
                        <Loader2
                          className="h-4 w-4 animate-spin text-ink-muted"
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      ) : isActive ? (
                        <Check
                          className="h-4 w-4 text-accent"
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      ) : (
                        <Building2
                          className="h-4 w-4 text-ink-muted"
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {restaurant.restaurantName}
                        </span>
                        <span className="block text-[11px] capitalize text-ink-muted">
                          {restaurant.role}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
            {switchError && (
              <p
                role="alert"
                className="mx-md my-xs text-[12px] text-danger"
              >
                {switchError}
              </p>
            )}
            <div className="mx-md my-xs border-t border-border" role="separator" />
            <Link
              ref={(el) => {
                itemsRef.current[restaurantItemCount] = el;
              }}
              href="/price-comparison"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <DollarSign className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Pricing
            </Link>
            <Link
              ref={(el) => {
                itemsRef.current[restaurantItemCount + 1] = el;
              }}
              href="/team"
              onClick={close}
              role="menuitem"
              tabIndex={-1}
              className="flex items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
            >
              <Users className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
              Team
            </Link>
            <div className="mx-md my-xs border-t border-border" role="separator" />
            <form action="/auth/signout" method="post">
              <button
                ref={(el) => {
                  itemsRef.current[restaurantItemCount + 2] = el;
                }}
                type="submit"
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-sm px-md py-sm text-[14px] text-ink transition-colors hover:bg-surface-muted"
              >
                <LogOut className="h-4 w-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
