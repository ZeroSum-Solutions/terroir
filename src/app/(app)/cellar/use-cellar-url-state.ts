"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  parseCellarUrlState,
  serializeCellarUrlState,
  type CellarUrlState,
} from "@/lib/cellar-facets/url-state";

/**
 * URL-backed state for the Cellar surface. Local patches merge over the
 * committed URL and navigate via native history.pushState/replaceState —
 * which Next syncs into useSearchParams WITHOUT a server roundtrip. The
 * cellar page reads no searchParams on the server, so a router.push here
 * used to re-render the whole force-dynamic page for byte-identical props
 * on every wine tap / filter change (tap→drawer measured 391ms baseline vs
 * 4429ms with the RSC fetch delayed — on mobile networks the drawer read
 * as broken). The committed searchParams remain the source of truth once
 * a navigation lands.
 */
export function useCellarUrlState() {
  const searchParams = useSearchParams();
  const urlState = useMemo(
    () => parseCellarUrlState(searchParams),
    [searchParams],
  );
  const urlStateRef = useRef(urlState);
  // Keys patched locally whose navigation has not been observed in the
  // committed URL yet. Navigations commit asynchronously, so the router can
  // re-deliver a snapshot that predates an in-flight patch; adopting it
  // wholesale would resurrect the old value and the next patch would then
  // serialize it back into the URL (the lost-update race the taxonomy e2e
  // caught on 2026-08-19). A pending key keeps its local value until any
  // snapshot agrees with it — including an external navigation that happens
  // to land on the same value.
  const pendingKeys = useRef(new Set<keyof CellarUrlState>());
  useEffect(() => {
    const merged = { ...urlState };
    for (const key of [...pendingKeys.current]) {
      if (urlState[key] === urlStateRef.current[key]) {
        pendingKeys.current.delete(key);
      } else {
        assign(merged, key, urlStateRef.current[key]);
      }
    }
    urlStateRef.current = merged;
  }, [urlState]);
  const applyUrlState = useCallback(
    (patch: Partial<CellarUrlState>, mode: "replace" | "push") => {
      const next = { ...urlStateRef.current, ...patch };
      urlStateRef.current = next;
      for (const key of Object.keys(patch) as Array<keyof CellarUrlState>) {
        pendingKeys.current.add(key);
      }
      const params = serializeCellarUrlState(next);
      const href = `/cellar?${params.toString()}`;
      if (mode === "push") window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
    },
    [],
  );
  const replaceUrlState = useCallback(
    (patch: Partial<CellarUrlState>) => applyUrlState(patch, "replace"),
    [applyUrlState],
  );
  return { urlState, urlStateRef, applyUrlState, replaceUrlState };
}

function assign<K extends keyof CellarUrlState>(
  target: CellarUrlState,
  key: K,
  value: CellarUrlState[K],
) {
  target[key] = value;
}
