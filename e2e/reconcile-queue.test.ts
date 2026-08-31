import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../src/types/database";

type Admin = SupabaseClient<Database>;
type Role = Database["public"]["Enums"]["membership_role"];
type Membership = { id: string; restaurant_id: string; role: Role };
const RUN = `${Date.now()}`;
const PRODUCER = `E2E Reconcile ${RUN}`;
const STARTED_AT = new Date().toISOString();
const RUN_SUFFIX = RUN.slice(-6);
const LWIN_BASE = RUN.slice(-4);

test.describe("@opp-5 reconciliation queue", () => {
  test.skip(!!process.env.CI, "Requires service-role fixtures and dev login.");
  test.describe.configure({ mode: "serial" });

  let membership: Membership;
  let binId: string;
  let scanId: string;
  let wineIds: string[] = [];
  let lineageIds: string[] = [];
  let batchId: string | null = null;
  let scanBefore: Record<string, unknown>;

  test.beforeAll(async () => {
    const admin = adminClient();
    membership = await resolveMembership(admin);
    if (membership.role !== "owner" && membership.role !== "manager") {
      throw new Error("OPP-5 E2E requires the dev user to be an owner or manager.");
    }
    binId = await insertBin(admin, membership.restaurant_id);
    const fixture = await insertWines(admin, membership.restaurant_id);
    wineIds = fixture.wineIds;
    lineageIds = fixture.lineageIds;
    scanId = await insertScan(admin, membership.restaurant_id, fixture.scanWineId);
    await insertInventory(admin, membership.restaurant_id, fixture, scanId, binId);
    scanBefore = await scanSnapshot(admin, scanId);
  });

  test.afterAll(async () => {
    const admin = adminClient();
    const captured = batchId ?? (await findBatchId(admin, scanId));
    if (captured) {
      await admin.from("reconcile_actions").delete().eq("batch_id", captured);
      await admin.from("reconcile_batches").delete().eq("id", captured);
    }
    if (wineIds.length) await admin.from("inventory_items").delete().in("wine_id", wineIds);
    if (scanId) await admin.from("invoice_scans").delete().eq("id", scanId);
    if (wineIds.length) await admin.from("wines").delete().in("id", wineIds);
    if (lineageIds.length) await admin.from("wine_lineages").delete().in("id", lineageIds);
    if (binId) await admin.from("bins").delete().eq("id", binId);
  });

  test("EV-5.1: header states item grain and all four issue kinds render", async ({ page }) => {
    await login(page);
    const response = await page.request.get("/api/reconcile-queue");
    expect(response.ok(), await response.text()).toBeTruthy();
    const payload = await response.json() as {
      summary: { itemCount: number; unitCount: number; atRisk: number };
      issues: Array<{ id: string; kind: string; title: string }>;
    };
    expect(payload.issues.filter((issue) => issue.title.includes(PRODUCER))).toHaveLength(4);
    const uiQueueResponse = page.waitForResponse((candidate) =>
      candidate.request().method() === "GET" &&
      new URL(candidate.url()).pathname === "/api/reconcile-queue",
    );
    await page.goto("/reconcile-queue");
    const uiPayload = await (await uiQueueResponse).json() as typeof payload;
    expect(uiPayload.issues.filter((issue) => issue.title.includes(PRODUCER))).toHaveLength(4);
    await revealFixtureRows(page);

    const expected = `${payload.summary.itemCount} items · ${payload.summary.unitCount} units · $${formatRisk(payload.summary.atRisk)} at risk`;
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
    for (const kind of ["unplaced", "unmatched_scan", "duplicate_suspect", "ambiguous_lineage"]) {
      await expect(page.locator(`[data-queue-kind="${kind}"]`, { hasText: PRODUCER })).toHaveCount(1);
    }
  });

  test("EV-5.2: ledger rows render in descending capital-at-risk order", async ({ page }) => {
    await login(page);
    await page.goto("/reconcile-queue");
    await revealFixtureRows(page);

    const risks = await page.locator("[data-queue-row]", { hasText: PRODUCER }).evaluateAll((rows) =>
      rows.map((row) => Number((row as HTMLElement).dataset.risk)),
    );
    expect(risks).toEqual([...risks].sort((left, right) => right - left));
  });

  test("EV-5.3: scan suggestion cites field identity rather than similarity", async ({ page }) => {
    await login(page);
    await page.goto("/reconcile-queue");
    await revealFixtureRows(page);

    const scanRow = page.locator('[data-queue-kind="unmatched_scan"]', { hasText: PRODUCER });
    await expect(scanRow.getByText("Field match", { exact: true })).toBeVisible();
    await expect(scanRow).toContainText("producer · cuvee · vintage · format");
  });

  test("EV-5.4: bulk accept then undo restores the invoice scan byte-for-byte", async ({ page }) => {
    await login(page);
    await page.goto("/reconcile-queue");
    await revealFixtureRows(page);
    const row = page.locator('[data-queue-kind="unmatched_scan"]', { hasText: PRODUCER });
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Accept 1 item" }).click();
    await expect(page.getByText("1 item accepted", { exact: true })).toBeVisible();

    batchId = await waitForBatchId(adminClient(), scanId);
    expect(await scanSnapshot(adminClient(), scanId)).not.toEqual(scanBefore);
    await page.getByRole("button", { name: "Undo latest batch" }).click();
    await expect(page.getByText("Latest batch undone", { exact: true })).toBeVisible();
    // Not a bare toEqual(scanBefore): migration 0089 put a `set_updated_at`
    // trigger on invoice_scans (every UPDATE bumps it, on purpose — it's the
    // optimistic-concurrency fence for /api/scans/[id]/re-extract) so a row
    // touched by accept then undo can never have its ORIGINAL updated_at
    // back. "Restores byte-for-byte" means every column undo is responsible
    // for; updated_at is asserted to have genuinely advanced instead, which
    // is a strictly stronger proof that undo really executed a write than a
    // vacuous "differs somehow" would be.
    const afterUndo = await scanSnapshot(adminClient(), scanId);
    expect(omit(afterUndo, "updated_at")).toEqual(omit(scanBefore, "updated_at"));
    expect(Date.parse(afterUndo.updated_at as string)).toBeGreaterThan(Date.parse(scanBefore.updated_at as string));
  });

  // Accept and undo are owner/manager only — both POST routes call
  // requireRole(["owner", "manager"]) — but the page made no auth call at
  // all, so a staff member saw an enabled bulk rail, an enabled undo button,
  // a checkbox on every actionable row and a bin picker, and learned none of
  // it worked only from the 403 that came back after the POST. The server
  // side was correct then and is unchanged; this asserts the affordance now
  // says the same thing the API does.
  test("EV-5.5: staff see the queue but none of the controls the API refuses", async ({ page }) => {
    const admin = adminClient();
    await admin.from("memberships").update({ role: "staff" }).eq("id", membership.id);
    try {
      await login(page);
      await page.goto("/reconcile-queue");
      await expect(page.locator("[data-queue-row]").first()).toBeVisible();

      await expect(page.getByRole("button", { name: /^Accept \d+ item/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Undo latest batch" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Select actionable/ })).toHaveCount(0);
      await expect(page.locator("[data-queue-row] input[type=checkbox]")).toHaveCount(0);
      await expect(page.locator("[data-queue-row] select")).toHaveCount(0);

      // Server-side authorization is unchanged, and must stay that way: the
      // hidden control is a truthfulness fix, not the access control.
      const refused = await page.request.post("/api/reconcile-queue/accept", {
        data: [{
          action_type: "dismiss",
          subject_table: "inventory_items",
          subject_id: "00000000-0000-4000-8000-000000000001",
          patch: {},
        }],
      });
      expect(refused.status()).toBe(403);
    } finally {
      await admin.from("memberships").update({ role: membership.role }).eq("id", membership.id);
    }
  });
});

function adminClient(): Admin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("OPP-5 E2E requires Supabase service credentials.");
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

async function checked<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  if (data == null) throw new Error("Fixture query returned no data");
  return data;
}

async function resolveMembership(admin: Admin): Promise<Membership> {
  const email = process.env.DEV_BYPASS_EMAIL;
  if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const user = data.users.find((candidate) => candidate.email === email);
  if (!user) throw new Error(`Dev user ${email} not found`);
  const rows = await checked(admin.from("memberships").select("id, restaurant_id, role")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(1));
  if (!rows[0]) throw new Error("No membership for dev user");
  return rows[0];
}

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function revealFixtureRows(page: Page) {
  const targets = page.locator("[data-queue-row]", { hasText: PRODUCER });
  await expect(page.locator("[data-queue-row]").first()).toBeVisible();
  for (let pageIndex = 0; pageIndex < 40; pageIndex += 1) {
    if ((await targets.count()) >= 4) return;
    const showMore = page.getByRole("button", { name: /^Show \d+ more/ });
    if (!(await showMore.count())) break;
    const before = await page.locator("[data-queue-row]").count();
    await showMore.click();
    await expect
      .poll(() => page.locator("[data-queue-row]").count())
      .toBeGreaterThan(before);
  }
  await expect(targets).toHaveCount(4);
}

async function insertBin(admin: Admin, restaurantId: string): Promise<string> {
  const rows = await checked(admin.from("bins").insert({
    restaurant_id: restaurantId,
    code: `RQ-${RUN_SUFFIX}`,
    zone: "E2E",
    priority: 99,
  }).select("id"));
  return rows[0].id;
}

async function insertWines(admin: Admin, restaurantId: string) {
  // wines_dedup_idx forbids identical (producer, name, vintage, size) rows, so
  // duplicate suspects share a lineage via identical LWIN with distinct names,
  // and the ambiguous trio shares its name norm across distinct vintages.
  const specs = [
    { name: "Duplicate Alpha", vintage: 2019, lwin_id: `8${LWIN_BASE}01` },
    { name: "Duplicate Beta", vintage: 2019, lwin_id: `8${LWIN_BASE}01` },
    { name: "Unplaced", vintage: 2020, lwin_id: `8${LWIN_BASE}02` },
    { name: "Field Match", vintage: 2021, lwin_id: `8${LWIN_BASE}03` },
    { name: "Ambiguous", vintage: 2022, lwin_id: `8${LWIN_BASE}04` },
    { name: "Ambiguous", vintage: 2023, lwin_id: `8${LWIN_BASE}05` },
    { name: "Ambiguous", vintage: 2024, lwin_id: null },
  ];
  const rows = await checked(admin.from("wines").insert(specs.map((spec) => ({
    restaurant_id: restaurantId,
    producer: PRODUCER,
    size_ml: 750,
    ...spec,
  }))).select("id, name, lwin_id, lineage_id"));
  return {
    wineIds: rows.map((row) => row.id),
    lineageIds: [...new Set(rows.flatMap((row) => row.lineage_id ? [row.lineage_id] : []))],
    duplicateIds: rows.filter((row) => row.name.startsWith("Duplicate")).map((row) => row.id),
    unplacedId: rows.find((row) => row.name === "Unplaced")!.id,
    scanWineId: rows.find((row) => row.name === "Field Match")!.id,
    ambiguousId: rows.find((row) => row.name === "Ambiguous" && row.lwin_id === null)!.id,
  };
}

async function insertScan(admin: Admin, restaurantId: string, scanWineId: string) {
  const line = { producer: PRODUCER, name: "Field Match", vintage: 2021, qty: 2, unitCost: 15, format: "750ml" };
  const final = [{ id: "line-1", ...line }, { id: "line-2", ...line }, { id: "line-3", ...line, wine_id: scanWineId }];
  const rows = await checked(admin.from("invoice_scans").insert({
    restaurant_id: restaurantId,
    distributor_name: PRODUCER,
    parsed_line_items: final as Json,
    final_line_items: final as Json,
  }).select("id"));
  return rows[0].id;
}

async function insertInventory(admin: Admin, restaurantId: string, fixture: Awaited<ReturnType<typeof insertWines>>, invoiceScanId: string, activeBinId: string) {
  const [first, second] = fixture.duplicateIds;
  await checked(admin.from("inventory_items").insert([
    { restaurant_id: restaurantId, wine_id: first, bin_id: null, quantity: 1, unit_cost: 9, format: "750ml", added_at: "2026-01-01" },
    { restaurant_id: restaurantId, wine_id: first, bin_id: null, quantity: 1, unit_cost: 11, format: "750ml", added_at: "2026-02-01" },
    // Bulk inserts null-fill omitted columns, bypassing the added_at default.
    { restaurant_id: restaurantId, wine_id: second, bin_id: activeBinId, quantity: 3, unit_cost: 20, format: "750ml", added_at: "2026-03-01" },
    { restaurant_id: restaurantId, wine_id: fixture.unplacedId, bin_id: null, quantity: 1, unit_cost: 50, format: "750ml", added_at: "2026-03-01" },
    { restaurant_id: restaurantId, wine_id: fixture.ambiguousId, bin_id: null, quantity: 4, unit_cost: 30, format: "750ml", added_at: "2026-03-01" },
    { restaurant_id: restaurantId, wine_id: fixture.scanWineId, invoice_scan_id: invoiceScanId, bin_id: activeBinId, quantity: 2, unit_cost: 15, format: "750ml", added_at: "2026-03-01" },
  ]).select("id"));
}

async function scanSnapshot(admin: Admin, id: string): Promise<Record<string, unknown>> {
  const rows = await checked(admin.from("invoice_scans").select("*").eq("id", id));
  if (!rows[0]) throw new Error("Fixture scan missing");
  return structuredClone(rows[0]) as Record<string, unknown>;
}

function omit(row: Record<string, unknown>, field: string): Record<string, unknown> {
  const { [field]: _dropped, ...rest } = row;
  return rest;
}

async function findBatchId(admin: Admin, subjectId: string): Promise<string | null> {
  if (!subjectId) return null;
  const rows = await checked(admin.from("reconcile_actions").select("batch_id")
    .eq("subject_table", "invoice_scans").eq("subject_id", subjectId).gte("created_at", STARTED_AT)
    .order("created_at", { ascending: false }).limit(1));
  return rows[0]?.batch_id ?? null;
}

async function waitForBatchId(admin: Admin, subjectId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = await findBatchId(admin, subjectId);
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Accepted reconcile batch was not persisted");
}

function formatRisk(value: number): string {
  // Must mirror reconcile-queue-client.tsx's own formatRisk exactly
  // (minimumFractionDigits: 2 too) — this fixture's unit costs are whole
  // dollars, so atRisk sums to a round number, and without the matching
  // minimum this rendered "80" against the page's real "80.00".
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
