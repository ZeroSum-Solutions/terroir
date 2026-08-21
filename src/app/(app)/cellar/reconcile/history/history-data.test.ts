import { describe, expect, it } from "vitest";
import {
  buildHistoryFromPersistedEvents,
  type ReconEvent,
} from "./history-data";

function persistedEvent(
  id: string,
  createdAt: string,
  delta: number | null,
): ReconEvent {
  return {
    id,
    created_at: createdAt,
    delta,
    note: null,
    user_id: "user-1",
    wine_id: `wine-${id}`,
    wines: {
      producer: "Producer",
      name: `Wine ${id}`,
      vintage: 2020,
    },
  };
}

describe("buildHistoryFromPersistedEvents", () => {
  it("inverts persisted deltas once and keeps the session net signed", () => {
    const events = [
      persistedEvent("1", "2026-08-20T18:00:00.000Z", 20),
      persistedEvent("2", "2026-08-20T18:05:00.000Z", -5),
    ];

    const [day] = buildHistoryFromPersistedEvents(events);

    expect(day.sessions[0].events.map((event) => event.delta)).toEqual([-20, 5]);
    expect(day.sessions[0].totalVarianceMl).toBe(-15);
    expect(day.totalVarianceMl).toBe(15);
  });

  it("preserves a persisted null delta and contributes zero to aggregation", () => {
    const [day] = buildHistoryFromPersistedEvents([
      persistedEvent("null", "2026-08-20T18:00:00.000Z", null),
    ]);

    expect(day.sessions[0].events[0].delta).toBeNull();
    expect(day.sessions[0].totalVarianceMl).toBe(0);
    expect(day.totalVarianceMl).toBe(0);
  });

  it("calculates a day as the sum of absolute session nets", () => {
    const [day] = buildHistoryFromPersistedEvents([
      persistedEvent("1", "2026-08-20T18:00:00.000Z", 20),
      persistedEvent("2", "2026-08-20T18:05:00.000Z", -5),
      persistedEvent("3", "2026-08-20T18:30:00.000Z", -10),
      persistedEvent("4", "2026-08-20T18:35:00.000Z", -5),
    ]);

    expect(day.sessions.map((session) => session.totalVarianceMl)).toEqual([-15, 15]);
    expect(day.totalVarianceMl).toBe(30);
  });
});
