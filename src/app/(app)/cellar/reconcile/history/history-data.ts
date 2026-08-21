export type ReconEvent = {
  id: string;
  created_at: string;
  delta: number | null;
  note: string | null;
  user_id: string | null;
  wine_id: string;
  wines: {
    producer: string;
    name: string;
    vintage: number | null;
  } | null;
};

export type ReconSession = {
  timeLabel: string;
  events: ReconEvent[];
  totalVarianceMl: number;
  bottleCount: number;
};

export type DayGroup = {
  date: string;
  displayDate: string;
  totalVarianceMl: number;
  eventCount: number;
  sessions: ReconSession[];
};

function formatDateHeader(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function presentReconcileEvent(event: ReconEvent): ReconEvent {
  return { ...event, delta: event.delta == null ? null : -event.delta };
}

export function buildHistoryFromPersistedEvents(events: ReconEvent[]): DayGroup[] {
  return buildHistory(events.map(presentReconcileEvent));
}

/**
 * Group reconciliation events into daily summaries and sessions.
 * Events within 10 minutes of each other are considered the same session.
 */
function buildHistory(events: ReconEvent[]): DayGroup[] {
  if (events.length === 0) return [];

  const SESSION_GAP_MS = 10 * 60 * 1000;
  const byDate = new Map<string, ReconEvent[]>();
  for (const event of events) {
    const dateKey = event.created_at.slice(0, 10);
    const dayEvents = byDate.get(dateKey) || [];
    dayEvents.push(event);
    byDate.set(dateKey, dayEvents);
  }

  const dayGroups: DayGroup[] = [];

  for (const [dateKey, dayEvents] of byDate) {
    dayEvents.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const sessions: ReconSession[] = [];
    let currentSession: ReconEvent[] = [dayEvents[0]];

    for (let i = 1; i < dayEvents.length; i++) {
      const previousTime = new Date(dayEvents[i - 1].created_at).getTime();
      const currentTime = new Date(dayEvents[i].created_at).getTime();
      if (currentTime - previousTime <= SESSION_GAP_MS) {
        currentSession.push(dayEvents[i]);
      } else {
        sessions.push(buildSession(currentSession));
        currentSession = [dayEvents[i]];
      }
    }
    sessions.push(buildSession(currentSession));

    const totalVarianceMl = sessions.reduce(
      (sum, session) => sum + Math.abs(session.totalVarianceMl),
      0,
    );

    dayGroups.push({
      date: dateKey,
      displayDate: formatDateHeader(dayEvents[0].created_at),
      totalVarianceMl,
      eventCount: dayEvents.length,
      sessions,
    });
  }

  dayGroups.sort((a, b) => b.date.localeCompare(a.date));
  return dayGroups;
}

function buildSession(events: ReconEvent[]): ReconSession {
  const totalVarianceMl = events.reduce(
    (sum, event) => sum + (event.delta ?? 0),
    0,
  );
  return {
    timeLabel: formatTime(events[0].created_at),
    events,
    totalVarianceMl,
    bottleCount: events.length,
  };
}
