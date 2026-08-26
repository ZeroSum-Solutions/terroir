import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellarUrlState } from "@/lib/cellar-facets/url-state";

/**
 * Reproduces the lost-update race from the 2026-08-19 live e2e run:
 * App Router navigations commit asynchronously, so between two rapid
 * filter changes the router can re-deliver a searchParams snapshot that
 * predates the first change. The hook must not let that stale snapshot
 * resurrect a param the user just cleared.
 */

// Native history calls (the hook's navigation channel since the shallow-nav
// fix) and Next router calls (which must stay untouched — a router call here
// means a full force-dynamic RSC roundtrip).
const replaceCalls: string[] = [];
const pushCalls: string[] = [];
const routerReplaceCalls: string[] = [];
const routerPushCalls: string[] = [];
const paramsHolder = { current: new URLSearchParams() };

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => routerReplaceCalls.push(href),
    push: (href: string) => routerPushCalls.push(href),
  }),
  useSearchParams: () => paramsHolder.current,
}));

const { useCellarUrlState } = await import("./use-cellar-url-state");

type HookApi = ReturnType<typeof useCellarUrlState>;

const apiHolder: { current: HookApi | null } = { current: null };
function api(): HookApi {
  if (!apiHolder.current) throw new Error("Harness not rendered");
  return apiHolder.current;
}
function Harness() {
  const hook = useCellarUrlState();
  useEffect(() => {
    apiHolder.current = hook;
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

function renderHarness() {
  act(() => {
    root.render(<Harness />);
  });
}

/** Deliver a searchParams update from the router (always a new identity). */
function deliverParams(query: string) {
  paramsHolder.current = new URLSearchParams(query);
  renderHarness();
}

function lastReplace(): URLSearchParams {
  const href = replaceCalls[replaceCalls.length - 1];
  return new URLSearchParams(href.split("?")[1] ?? "");
}

beforeEach(() => {
  replaceCalls.length = 0;
  pushCalls.length = 0;
  routerReplaceCalls.length = 0;
  routerPushCalls.length = 0;
  vi.spyOn(window.history, "pushState").mockImplementation(
    (_state, _unused, url) => pushCalls.push(String(url)),
  );
  vi.spyOn(window.history, "replaceState").mockImplementation(
    (_state, _unused, url) => replaceCalls.push(String(url)),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useCellarUrlState", () => {
  it("navigates via native history (shallow) — never the Next router", () => {
    // The cellar page reads no searchParams on the server: every param is
    // client-consumed, so a router.push/replace forces a full force-dynamic
    // RSC roundtrip that re-renders the whole page for byte-identical props.
    // Measured 2026-08-26: tap→drawer 391ms baseline vs 4429ms with the RSC
    // fetch delayed 4s — on mobile networks the drawer reads as broken.
    // window.history.pushState/replaceState sync useSearchParams without a
    // server fetch (next/dist/docs single-page-applications.md).
    paramsHolder.current = new URLSearchParams("filter=all");
    renderHarness();

    act(() => api().applyUrlState({ wine: "wine-1" }, "push"));
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toContain("wine=wine-1");

    act(() => api().replaceUrlState({ groupBy: "producer" }));
    expect(replaceCalls).toHaveLength(1);

    expect(routerPushCalls).toEqual([]);
    expect(routerReplaceCalls).toEqual([]);
  });

  it("does not resurrect a cleared param when a stale snapshot lands between rapid changes", () => {
    paramsHolder.current = new URLSearchParams("filter=all&region=Napa");
    renderHarness();

    act(() => api().replaceUrlState({ region: null }));
    expect(lastReplace().get("region")).toBeNull();

    // Router re-delivers a snapshot from before the clear committed
    // (same value, new object identity — e.g. a late hydration sync).
    deliverParams("filter=all&region=Napa");

    act(() => api().replaceUrlState({ groupBy: "producer" }));
    const params = lastReplace();
    expect(params.get("group_by")).toBe("producer");
    expect(params.get("region")).toBeNull();
  });

  it("adopts external navigations when no local change is pending", () => {
    paramsHolder.current = new URLSearchParams("filter=all&region=Napa");
    renderHarness();

    // e.g. browser Back: filter changed externally.
    deliverParams("filter=open");

    act(() => api().replaceUrlState({ groupBy: "region" }));
    const params = lastReplace();
    expect(params.get("filter")).toBe("open");
    expect(params.get("region")).toBeNull();
    expect(params.get("group_by")).toBe("region");
  });

  it("releases a pending key once the URL reflects it", () => {
    paramsHolder.current = new URLSearchParams("filter=all&region=Napa");
    renderHarness();

    act(() => api().replaceUrlState({ region: null }));
    // The clear commits.
    deliverParams("filter=all");
    // Later, an external navigation restores a region.
    deliverParams("filter=all&region=Sonoma");

    act(() => api().replaceUrlState({ groupBy: "producer" }));
    expect(lastReplace().get("region")).toBe("Sonoma");
  });

  it("keeps every patch when several land before any commit", () => {
    paramsHolder.current = new URLSearchParams("filter=all&region=Napa");
    renderHarness();

    act(() => api().replaceUrlState({ region: null }));
    deliverParams("filter=all&region=Napa"); // stale
    act(() => api().replaceUrlState({ vintageMin: 2019 }));
    deliverParams("filter=all&region=Napa"); // still stale
    act(() => api().replaceUrlState({ groupBy: "vintage" } satisfies Partial<CellarUrlState>));

    const params = lastReplace();
    expect(params.get("region")).toBeNull();
    expect(params.get("vintage_min")).toBe("2019");
    expect(params.get("group_by")).toBe("vintage");
  });
});
