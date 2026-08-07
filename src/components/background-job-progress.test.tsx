// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundJobSummary } from "@/lib/jobs/progress";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => {
  const query = {
    eq: vi.fn(),
    limit: vi.fn(),
    order: vi.fn(),
    select: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return {
    client: { from: vi.fn(), rpc: vi.fn() },
    query,
    queryResults: [] as Array<{ data: unknown; error: unknown }>,
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => mocks.client,
}));

const { BackgroundJobProgress } = await import("./background-job-progress");

const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";

function job(
  index: number,
  overrides: Partial<BackgroundJobSummary> = {},
): BackgroundJobSummary {
  const suffix = String(index).padStart(12, "0");
  return {
    attempt_count: 0,
    created_at: "2026-08-07T12:00:00.000Z",
    dead_lettered_at: null,
    finished_at: null,
    id: `11111111-1111-4111-8111-${suffix}`,
    job_type: "invoice_ocr",
    max_attempts: 3,
    restaurant_id: RESTAURANT_ID,
    run_after: "2026-08-07T12:00:00.000Z",
    started_at: null,
    status: "queued",
    subject_id: `33333333-3333-4333-8333-${suffix}`,
    subject_table: "invoice_scans",
    updated_at: "2026-08-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("BackgroundJobProgress", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryResults.length = 0;
    mocks.client.from.mockReturnValue(mocks.query);
    mocks.query.limit.mockImplementation(async () =>
      mocks.queryResults.shift() ?? { data: [], error: null }
    );
    mocks.client.rpc.mockResolvedValue({ data: null, error: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(
    jobs: BackgroundJobSummary[],
    userRole: "owner" | "manager" | "staff" = "manager",
  ) {
    mocks.queryResults.push({ data: jobs, error: null });
    await act(async () => {
      root.render(
        <BackgroundJobProgress
          initialJobs={jobs}
          restaurantId={RESTAURANT_ID}
          userRole={userRole}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.client.from).toHaveBeenCalled());
  }

  it("renders honest shared states with accessible mobile-sized actions", async () => {
    const jobs = [
      job(1),
      job(2, { status: "running", attempt_count: 1 }),
      job(3, { status: "retrying", attempt_count: 1 }),
      job(4, { status: "failed", finished_at: "2026-08-07T12:05:00.000Z" }),
      job(5, {
        status: "failed",
        attempt_count: 3,
        dead_lettered_at: "2026-08-07T12:05:00.000Z",
        finished_at: "2026-08-07T12:05:00.000Z",
      }),
      job(6, { status: "succeeded", finished_at: "2026-08-07T12:05:00.000Z" }),
    ];
    await render(jobs);

    expect(container.textContent).toContain("Queued");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Retrying");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Dead-lettered");
    expect(container.textContent).toContain("Succeeded");
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label^="Retry "]')).toHaveLength(2);
    for (const action of container.querySelectorAll("button")) {
      expect(action.className).toContain("min-h-11");
    }
    expect(mocks.query.eq).toHaveBeenCalledWith(
      "restaurant_id",
      RESTAURANT_ID,
    );
  });

  it("hides retry from staff even when a dead letter is readable", async () => {
    const deadLetter = job(1, {
      status: "failed",
      attempt_count: 3,
      dead_lettered_at: "2026-08-07T12:05:00.000Z",
      finished_at: "2026-08-07T12:05:00.000Z",
    });
    await render([deadLetter], "staff");

    expect(container.textContent).toContain("Dead-lettered");
    expect(container.querySelector('[aria-label^="Retry "]')).toBeNull();
    expect(mocks.client.rpc).not.toHaveBeenCalled();
  });

  it("requeues with both tenant and job identity and updates immediately", async () => {
    const deadLetter = job(1, {
      status: "failed",
      attempt_count: 3,
      dead_lettered_at: "2026-08-07T12:05:00.000Z",
      finished_at: "2026-08-07T12:05:00.000Z",
    });
    await render([deadLetter]);
    mocks.client.rpc.mockResolvedValueOnce({
      data: job(1),
      error: null,
    });

    await act(async () => {
      (container.querySelector('[aria-label^="Retry "]') as HTMLButtonElement)
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.client.rpc).toHaveBeenCalledWith(
      "requeue_background_job",
      { p_job_id: deadLetter.id, p_restaurant_id: RESTAURANT_ID },
    );
    expect(container.textContent).toContain("Queued");
    expect(container.textContent).not.toContain("Dead-lettered");
  });

  it("recovers stale page state on pageshow", async () => {
    const running = job(1, { status: "running", attempt_count: 1 });
    const succeeded = job(1, {
      status: "succeeded",
      attempt_count: 1,
      finished_at: "2026-08-07T12:05:00.000Z",
    });
    await render([running]);
    mocks.queryResults.push({ data: [succeeded], error: null });

    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Succeeded");
    expect(mocks.client.from).toHaveBeenCalledTimes(2);
  });
});
