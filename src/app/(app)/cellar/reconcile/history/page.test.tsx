import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mocks.getAuthContext(...args),
}));

const persistedPositiveEvent = persistedEvent(
  "positive",
  "2026-08-20T18:00:00.000Z",
  20,
  "Persisted Positive",
);
const persistedNegativeEvent = persistedEvent(
  "negative",
  "2026-08-20T18:30:00.000Z",
  -20,
  "Persisted Negative",
);
const persistedZeroEvent = persistedEvent(
  "zero",
  "2026-08-20T19:00:00.000Z",
  0,
  "Persisted Zero",
);

const query = {
  select: vi.fn(() => query),
  eq: vi.fn(() => query),
  order: vi.fn(() => query),
  limit: vi.fn().mockResolvedValue({
    data: [persistedPositiveEvent, persistedNegativeEvent, persistedZeroEvent],
    error: null,
  }),
};

const { default: ReconcileHistoryPage } = await import("./page");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthContext.mockResolvedValue({
    user: { id: "user-1" },
    userRole: "owner",
    restaurantId: "restaurant-1",
    restaurantName: "House",
    supabase: { from: vi.fn(() => query) },
  });
});

describe("ReconcileHistoryPage variance presentation", () => {
  it("presents persisted deltas with inventory-accurate signs, relations, and tones", async () => {
    const markup = renderToStaticMarkup(await ReconcileHistoryPage());
    const container = document.createElement("div");
    container.innerHTML = markup;

    expectPresentation(container, "positive", {
      copy: "−0.7 oz · under expected",
      background: "bg-blush-wash",
      text: "text-primary",
    });
    expectPresentation(container, "negative", {
      copy: "+0.7 oz · over expected",
      background: "bg-sage-wash",
      text: "text-sage-ink",
    });
    expectPresentation(container, "zero", {
      copy: "0.0 oz · exact",
      background: "bg-bridge-surface",
      text: "text-grey",
    });
  });

  it("keeps the daily summary and chart absolute", async () => {
    const markup = renderToStaticMarkup(await ReconcileHistoryPage());
    const container = document.createElement("div");
    container.innerHTML = markup;

    const totalVarianceLabel = [...container.querySelectorAll("div")].find(
      (element) => element.textContent === "Total variance",
    );
    expect(totalVarianceLabel?.nextElementSibling?.textContent).toBe("1.4 oz");
    expect(container.textContent).toContain("1.4 oz variance");
    expect(container.querySelector('[title$=": 1.4 oz"]')).not.toBeNull();
    expect(markup).not.toContain("+1.4 oz");
    expect(markup).not.toContain("−1.4 oz");
  });
});

function persistedEvent(
  id: string,
  createdAt: string,
  delta: number,
  producer: string,
) {
  return {
    id,
    created_at: createdAt,
    delta,
    note: null,
    user_id: "user-1",
    wine_id: `wine-${id}`,
    wines: { producer, name: "Wine", vintage: 2020 },
  };
}

function expectPresentation(
  container: HTMLElement,
  id: string,
  expected: { copy: string; background: string; text: string },
) {
  const wineLink = container.querySelector(`a[href="/cellar?wine=wine-${id}"]`);
  const sessionCard = wineLink?.closest(".rounded-md.border.border-border.bg-white");
  expect(sessionCard, `session card for ${id}`).not.toBeNull();

  const sessionBadge = sessionCard?.firstElementChild?.querySelector("span.inline-flex");
  expect(sessionBadge?.textContent?.replace(/\s+/g, " ").trim()).toBe(expected.copy);
  expect(sessionBadge?.classList.contains(expected.background)).toBe(true);
  expect(sessionBadge?.classList.contains(expected.text)).toBe(true);

  const eventRow = wineLink?.closest("tr");
  const eventVariance = eventRow?.querySelector("td:nth-child(2) span");
  expect(eventVariance?.textContent?.replace(/\s+/g, " ").trim()).toBe(expected.copy);
  expect(eventVariance?.classList.contains(expected.text)).toBe(true);
}
