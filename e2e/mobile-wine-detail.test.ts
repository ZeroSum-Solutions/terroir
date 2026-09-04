import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  DEMO_RESTAURANT_ID,
  PRODSHAPE_RESTAURANT_ID,
  enterProdShape,
  leaveProdShape,
} from "./prodshape";

/**
 * "If I click on any wine anywhere in the application on my mobile phone, I
 * should see the wine — the info, the producer, and especially the image."
 *
 * That sentence, encoded. Every surface that puts a wine in front of a phone
 * user gets one test: tap it, then prove the destination shows the producer,
 * at least one substantive attribute (region / country / varietal / vintage /
 * size), and an honest visual identity. A wine that owns a photograph must
 * show a loaded <img>; a reproducible seed wine with no photograph may show a
 * resolved corpus image or the explicit initials fallback. The test never
 * pretends a fallback is a label photograph.
 *
 * The viewport is 390x844 throughout, because "on my mobile phone" is half the
 * requirement: several of these surfaces have a `md:` layout that carries a
 * link and a `md:hidden` layout that does not, so a desktop-width run reports
 * a pass the phone never sees.
 *
 * NOT `mode: "serial"`, unlike the sibling suites. Serial stops the group at
 * the first failure, and this spec is written to be *partly red*: it encodes
 * the requirement, not today's behaviour, so each surface that cannot show a
 * wine must report its own failure. Nothing here writes, and `workers: 1` in
 * playwright.config.ts already prevents overlap.
 *
 * Conventions follow bins.test.ts (service-role lookup of the dev tenant),
 * cellar-control-row.test.ts and global-search.test.ts (dev-login auth, hard
 * skip unless Supabase is loopback — .env.local holds production credentials).
 */

const PHONE = { width: 390, height: 844 } as const;

/** Below this a picture is a decoration or a broken-image glyph, not "the image". */
const MIN_IMAGE_PX = 24;

function isLoopbackSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

const CAN_RUN =
  isLoopbackSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  Boolean(process.env.DEV_BYPASS_EMAIL);

type WineFacts = {
  id: string;
  name: string;
  producer: string | null;
  vintage: number | null;
  region: string | null;
  country: string | null;
  varietal: string | null;
  size_ml: number | null;
  hero_image_url: string | null;
};

type ImageBox = {
  src: string;
  width: number;
  height: number;
  naturalWidth: number;
  complete: boolean;
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "mobile-wine-detail requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** The tenant the dev-login identity lands in — same resolution as bins.test.ts. */
async function resolveRestaurantId(): Promise<string> {
  const email = process.env.DEV_BYPASS_EMAIL;
  if (!email) throw new Error("DEV_BYPASS_EMAIL not set");
  const admin = adminClient();
  const { data: users, error: userError } = await admin.auth.admin.listUsers({
    perPage: 200,
  });
  if (userError) throw userError;
  const user = users.users.find((candidate) => candidate.email === email);
  if (!user) throw new Error(`Dev user ${email} not found`);
  const { data, error } = await admin
    .from("memberships")
    .select("restaurant_id, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data?.[0]) throw new Error("No membership for dev user");
  return data[0].restaurant_id as string;
}

let winesById = new Map<string, WineFacts>();

async function login(page: Page) {
  const response = await page.request.get("/api/dev-login");
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** The wine drawer, distinguished from the app's other dialogs (Atlas country
 *  sheet, reconcile modal, add-wine sheet) by the heading id it owns. */
function wineDrawer(page: Page): Locator {
  return page
    .getByRole("dialog")
    .filter({ has: page.locator("#wine-detail-heading") });
}

/**
 * Poll `probe` until `done` accepts it; return the last value either way.
 *
 * Playwright's auto-waiting covers locators, not derived facts, and every
 * assertion below is a derived fact: an image's decoded box, the visible text
 * of a streaming server route, the rows a client fetch has produced. Reading
 * one once lands while `loading.tsx` is still on screen and reports an empty
 * page as a missing wine. Returning the last value rather than throwing is
 * what lets each caller say what it actually saw.
 */
async function until<T>(
  page: Page,
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (done(value) || Date.now() > deadline) return value;
    await page.waitForTimeout(250);
  }
}

/** Rendered geometry of every <img> inside `scope`, straight off the box model. */
async function imagesIn(scope: Locator): Promise<ImageBox[]> {
  return scope.evaluate((root) =>
    Array.from(root.querySelectorAll("img")).map((img) => {
      const rect = img.getBoundingClientRect();
      return {
        src: img.currentSrc || img.getAttribute("src") || "",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        naturalWidth: img.naturalWidth,
        complete: img.complete,
      };
    }),
  );
}

function isOnScreen(image: ImageBox): boolean {
  return (
    image.width >= MIN_IMAGE_PX &&
    image.height >= MIN_IMAGE_PX &&
    image.complete &&
    image.naturalWidth > 0
  );
}

/**
 * The image half of the requirement.
 *
 * Reports every <img> it saw on failure — a zero-box image, a never-decoded
 * image and no image at all are three different bugs with three different
 * owners, and the message has to say which one happened.
 */
async function expectWineImageOnScreen(
  page: Page,
  scope: Locator,
  wine: WineFacts,
  surface: string,
) {
  const seen = await until(
    page,
    () => imagesIn(scope),
    (images) => images.some(isOnScreen),
    10_000,
  );
  if (seen.some(isOnScreen)) return;

  expect(
    wine.hero_image_url,
    `${surface}: the fixture promises a wine image, but no loaded image was ` +
      `on screen. Saw: ${JSON.stringify(seen)}`,
  ).toBeNull();
  const fallback = scope.locator('[data-wine-image-fallback="true"]');
  await expect(
    fallback,
    `${surface}: no loaded corpus image and no explicit no-photo fallback appeared`,
  ).toBeVisible();
  const box = await fallback.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_IMAGE_PX);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_IMAGE_PX);
}

/** Text a phone user can actually read: excludes display:none subtrees (so a
 *  `hidden md:block` desktop table cannot satisfy a mobile assertion), and is
 *  compared case-insensitively because innerText applies `text-transform`. */
async function visibleText(scope: Locator): Promise<string> {
  const text = await scope.evaluate((el) => (el as HTMLElement).innerText ?? "");
  return text.replace(/\s+/g, " ").toLocaleLowerCase();
}

async function pollVisibleText(
  page: Page,
  scope: Locator,
  needle: string,
  timeout = 20_000,
): Promise<{ found: boolean; text: string }> {
  const wanted = needle.toLocaleLowerCase();
  const text = await until(
    page,
    () => visibleText(scope),
    (value) => value.includes(wanted),
    timeout,
  );
  return { found: text.includes(wanted), text };
}

/** Wait until <main> has painted something, so "no wines here" is a finding
 *  about the surface rather than about how fast it streamed. */
async function waitForMainContent(page: Page, surface: string) {
  const text = await until(
    page,
    () => visibleText(page.locator("main")),
    (value) => value.length > 0,
    20_000,
  );
  expect(text, `${surface}: <main> never rendered anything`).not.toBe("");
}

/** Count that tolerates a late-arriving client fetch before answering zero. */
async function countWhenSettled(
  page: Page,
  locator: Locator,
  timeout = 15_000,
): Promise<number> {
  return until(page, () => locator.count(), (count) => count > 0, timeout);
}

function substantiveAttributes(wine: WineFacts): string[] {
  return [
    wine.region,
    wine.country,
    wine.varietal,
    wine.vintage !== null ? String(wine.vintage) : null,
    wine.size_ml !== null ? `${wine.size_ml} ml` : null,
  ].filter((value): value is string => Boolean(value));
}

/** All three assertions, against whatever container the tap landed in. */
async function expectWineIsShown(
  page: Page,
  scope: Locator,
  wine: WineFacts,
  surface: string,
) {
  await expect(scope, `${surface}: nothing opened`).toBeVisible();

  const producer = wine.producer?.trim();
  expect(
    producer && producer.length > 0,
    `${surface}: fixture wine ${wine.id} has no producer to assert on`,
  ).toBeTruthy();
  const { found, text } = await pollVisibleText(page, scope, producer!);
  expect(
    found,
    `${surface}: producer "${producer}" never appeared on screen. ` +
      `Saw: ${text.slice(0, 400) || "(nothing — the container is empty)"}`,
  ).toBe(true);

  const attributes = substantiveAttributes(wine);
  expect(
    attributes.some((value) => text.includes(value.toLocaleLowerCase())),
    `${surface}: none of [${attributes.join(", ")}] is on screen. ` +
      `Saw: ${text.slice(0, 400)}`,
  ).toBe(true);

  await expectWineImageOnScreen(page, scope, wine, surface);
}

/**
 * Wait for a tap to land somewhere that can show a wine: either the cellar
 * drawer opened, or we navigated to the wine's own page. Returns the scope to
 * assert inside.
 */
async function wineDetailScope(
  page: Page,
  wineId: string,
  surface: string,
): Promise<Locator> {
  const drawer = wineDrawer(page);
  const detailPath = `/cellar/${wineId}`;
  let where = "none";
  await expect
    .poll(
      async () => {
        if ((await drawer.count()) > 0 && (await drawer.first().isVisible())) {
          where = "drawer";
        } else if (new URL(page.url()).pathname === detailPath) {
          where = "page";
        } else {
          where = "none";
        }
        return where;
      },
      {
        timeout: 15_000,
        message:
          `${surface}: tapping the wine opened neither the wine drawer nor ` +
          `${detailPath}. This is the "click a wine anywhere and see it" ` +
          `requirement failing at the navigation step, not the image step.`,
      },
    )
    .not.toBe("none");
  return where === "drawer" ? drawer.first() : page.locator("main");
}

/** A wine id embedded in a `/cellar?wine=<id>` or `/cellar/<id>` href. */
function wineIdFromHref(href: string | null): string | null {
  if (!href) return null;
  const query = /[?&]wine=([0-9a-f-]{36})/i.exec(href);
  if (query) return query[1];
  const path = /\/cellar\/([0-9a-f-]{36})(?:[?#]|$)/i.exec(href);
  return path ? path[1] : null;
}

/**
 * Every href inside `scope` that a phone user can see AND that resolves to a
 * wine. Deliberately not `a[href*="/cellar/"]`: on /cellar/reconcile that
 * pattern matches the "History" chrome link, which would report a wine tap
 * target where there is none.
 */
async function visibleWineHrefs(scope: Locator): Promise<string[]> {
  const hrefs = await scope
    .locator("a[href]")
    .filter({ visible: true })
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") ?? ""));
  return hrefs.filter((href) => wineIdFromHref(href) !== null);
}

function wineFacts(wineId: string | null): WineFacts {
  expect(wineId, "no wine id on the element that was tapped").not.toBeNull();
  const wine = winesById.get(wineId!);
  expect(wine, `wine ${wineId} is not in the dev tenant`).toBeTruthy();
  return wine!;
}

test.describe("@mobile-wine-detail tapping a wine shows the wine, at 390px", () => {
  test.skip(
    !CAN_RUN,
    "Requires a loopback Supabase plus SUPABASE_SERVICE_ROLE_KEY and " +
      "DEV_BYPASS_EMAIL; .env.local points at production.",
  );
  // /cellar is force-dynamic over the whole tenant and several of these routes
  // compile on first hit under Turbopack; 30s is not enough for a cold one.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    const restaurantId = await resolveRestaurantId();
    expect(restaurantId).toBe(DEMO_RESTAURANT_ID);
    const admin = adminClient();
    const { data, error } = await admin
      .from("wines")
      .select(
        "id, name, producer, vintage, region, country, varietal, size_ml, hero_image_url",
      )
      .in("restaurant_id", [restaurantId, PRODSHAPE_RESTAURANT_ID]);
    if (error) throw error;
    winesById = new Map((data ?? []).map((wine) => [wine.id, wine as WineFacts]));
    expect(
      winesById.size,
      "the dev tenant has no wines — seed the local stack first",
    ).toBeGreaterThan(0);
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
  });

  test("cellar list row opens the wine", async ({ page }) => {
    await page.goto("/cellar");
    const row = page.locator("[data-cellar-row]").first();
    await expect(row).toBeVisible();
    const wine = wineFacts(await row.getAttribute("data-cellar-row"));

    // At 390px the drag handle is `hidden ... md:flex` and select mode is off,
    // so the row's only button in the accessibility tree is the wine itself.
    await row.getByRole("button").first().click();

    const scope = await wineDetailScope(page, wine.id, "/cellar row");
    await expectWineIsShown(page, scope, wine, "/cellar row → drawer");
  });

  test("cellar deep link ?wine= opens the drawer", async ({ page }) => {
    // Every cross-surface wine link in the app resolves here: /bins,
    // /insights, /price-comparison, /cellar/open, reconcile history and the
    // reconcile queue all navigate to /cellar?wine=<id>. If this is broken,
    // all of them are.
    const wine = wineFacts("de100001-0000-4000-8000-000000000054");
    await page.goto(`/cellar?wine=${wine.id}`);
    const scope = await wineDetailScope(page, wine.id, "/cellar?wine=");
    await expectWineIsShown(page, scope, wine, "/cellar?wine= → drawer");
  });

  test("the drawer's Full detail link opens the wine's own page", async ({
    page,
  }) => {
    const wine = wineFacts("de100001-0000-4000-8000-000000000054");
    await page.goto(`/cellar?wine=${wine.id}`);
    const drawer = wineDrawer(page);
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Full detail" }).click();
    await page.waitForURL(`**/cellar/${wine.id}`);
    await expectWineIsShown(page, page.locator("main"), wine, "/cellar/[wineId]");
  });

  test("taxonomy grouping rows open the wine", async ({ page }) => {
    await page.goto("/cellar?group_by=producer");
    const group = page.locator("[data-cellar-taxonomy-group]").first();
    await expect(group, "no taxonomy group rendered").toBeVisible();
    const row = group.locator("[data-cellar-row]").first();
    await expect(row).toBeVisible();
    const wine = wineFacts(await row.getAttribute("data-cellar-row"));

    await row.getByRole("button").first().click();
    const scope = await wineDetailScope(page, wine.id, "/cellar?group_by=");
    await expectWineIsShown(page, scope, wine, "taxonomy group row → drawer");
  });

  test("grid view: a bottle inside a bin opens the wine", async ({ page }) => {
    await page.goto("/cellar");
    const gridToggle = page.getByRole("button", { name: "Grid view" });
    // getByRole ignores display:none, so a count of 0 IS the phone's answer —
    // but it has to be a count taken AFTER the control bar renders. `count()`
    // is a one-shot query with no auto-retry, so in the full suite (server warm
    // with 70 other specs behind it) it read 0 before the bar existed and
    // reported a desktop-only toggle that was in fact right there. Isolated, the
    // same test passed. `toHaveCount` retries, so this now measures the phone
    // rather than the render clock.
    await expect(
      gridToggle,
      "cellar-control-bar.tsx:123 — the List/Grid toggle is " +
        "`hidden … md:inline-flex`, so on a phone the bin-grid view cannot be " +
        "reached at all, and with it the CELLAR-08 'tap a bottle in a bin' " +
        "path at cellar-grid.tsx:301. There is no ?view= param to reach it by " +
        "either: cellar-shell.tsx:96 holds the view in useState.",
    ).toHaveCount(1);
    await gridToggle.click();

    const occupied = page
      .locator('[role="button"][aria-label*="bottle"]')
      .first();
    await expect(occupied, "no occupied bin on the cellar grid").toBeVisible();
    await occupied.click();

    const bottle = page.locator("button[data-bin-wine]").first();
    await expect(bottle, "the opened bin lists no bottles").toBeVisible();
    const expectedWineId = await bottle.getAttribute("data-bin-wine");
    await bottle.click();

    const drawer = wineDrawer(page);
    await expect(
      drawer,
      "cellar grid: tapping a bottle in a bin did not open the wine drawer",
    ).toBeVisible();
    const wineId = await drawer.evaluate(
      () =>
        new URL(window.location.href).searchParams.get("wine") ?? "",
    );
    expect(wineId, "cellar grid opened a different wine than the one tapped").toBe(
      expectedWineId,
    );
    const wine = wineFacts(wineId || null);
    await expectWineIsShown(page, drawer, wine, "cellar grid bin → drawer");
  });

  test("global search result opens the wine", async ({ page }) => {
    await page.goto("/cellar");
    const field = page
      .locator('input[type="search"][data-global-search]')
      .filter({ visible: true });
    await expect(field, "no visible global search field at 390px").toHaveCount(1);

    const wine = wineFacts("de100001-0000-4000-8000-000000000054");
    await field.fill(wine.name.slice(0, 12));
    const panel = page.locator("[data-global-search-panel]");
    await expect(panel).toBeVisible();
    const hit = panel
      .getByRole("option")
      .filter({ hasText: wine.producer ?? wine.name })
      .first();
    await expect(hit, "global search returned no row for the seeded wine").toBeVisible();
    await hit.click();

    await page.waitForURL(`**/cellar/${wine.id}`);
    await expectWineIsShown(
      page,
      page.locator("main"),
      wine,
      "global search → /cellar/[wineId]",
    );
  });

  test("bins: a bottle inside an expanded bin opens the wine", async ({
    page,
  }) => {
    await enterProdShape(page);
    try {
      await page.goto("/bins");
      const expandable = page
        .locator("[data-bin-row] button[aria-expanded]:not([disabled])")
        .filter({ visible: true })
        .first();
      await expect(expandable, "no bin on /bins holds any bottles").toBeVisible();
      await expandable.click();

      const link = page.locator("[data-bin-wine]").first();
      await expect(link).toBeVisible();
      const wine = wineFacts(await link.getAttribute("data-bin-wine"));
      await link.click();

      const scope = await wineDetailScope(page, wine.id, "/bins expanded bin");
      await expectWineIsShown(page, scope, wine, "/bins bin bottle → drawer");
    } finally {
      await leaveProdShape(page);
    }
  });

  test("bins: a 'Find a bottle' search result opens the wine", async ({
    page,
  }) => {
    // bin-manager.tsx:81 — SearchResults renders each match as a plain
    // <div data-bottle-match>. Somebody sent to the floor to find a bottle
    // searches for it here, sees it, taps it and nothing happens.
    await enterProdShape(page);
    try {
      await page.goto("/bins");
      const { data: placed, error: placedError } = await adminClient()
        .from("inventory_items")
        .select("wine_id")
        .eq("restaurant_id", PRODSHAPE_RESTAURANT_ID)
        .not("bin_id", "is", null);
      if (placedError) throw placedError;
      const anyWine = (placed ?? [])
        .map((item) => winesById.get(item.wine_id))
        .find((wine) => wine?.producer?.trim());
      expect(
        anyWine,
        "no placed wine with a producer in the prodshape tenant",
      ).toBeTruthy();

      const search = page.getByRole("searchbox", { name: "Find a bottle" });
      await expect(search).toBeVisible();
      await search.fill(anyWine!.producer!.toLowerCase());

      const tappable = page.locator(
        `[data-bottle-match] a[href="/cellar?wine=${anyWine!.id}"]`,
      ).first();
      await expect(
        tappable,
        "the bottle search did not return the placed fixture wine",
      ).toBeVisible();

      const wineId = wineIdFromHref(await tappable.getAttribute("href"));
      const wine = wineFacts(wineId);
      await tappable.click();
      const scope = await wineDetailScope(page, wine.id, "/bins bottle search");
      await expectWineIsShown(page, scope, wine, "/bins bottle search → drawer");
    } finally {
      await leaveProdShape(page);
    }
  });

  test("insights drill-down opens the wine", async ({ page }) => {
    await page.goto("/insights");
    const link = page
      .locator('a[href*="/cellar?wine="]')
      .filter({ visible: true })
      .first();
    await expect(
      link,
      "/insights offered no per-wine drill-down to tap at 390px",
    ).toBeVisible();
    const wine = wineFacts(wineIdFromHref(await link.getAttribute("href")));
    await link.click();

    const scope = await wineDetailScope(page, wine.id, "/insights drill-down");
    await expectWineIsShown(page, scope, wine, "/insights drill-down → drawer");
  });

  test("price comparison card opens the wine", async ({ page }) => {
    await page.goto("/price-comparison");
    const link = page
      .locator('a[href*="/cellar?wine="]')
      .filter({ visible: true })
      .first();
    await expect(
      link,
      "/price-comparison offered no wine link visible at 390px",
    ).toBeVisible();
    const wine = wineFacts(wineIdFromHref(await link.getAttribute("href")));
    await link.click();

    const scope = await wineDetailScope(page, wine.id, "/price-comparison");
    await expectWineIsShown(page, scope, wine, "/price-comparison → drawer");
  });

  test("an open bottle opens the wine", async ({ page }) => {
    await page.goto("/cellar/open");
    const link = page
      .locator('a[href*="/cellar?wine="]')
      .filter({ visible: true })
      .first();
    await expect(link, "/cellar/open listed no open bottle to tap").toBeVisible();
    const wine = wineFacts(wineIdFromHref(await link.getAttribute("href")));
    await link.click();

    const scope = await wineDetailScope(page, wine.id, "/cellar/open");
    await expectWineIsShown(page, scope, wine, "/cellar/open row → drawer");
  });

  test("reconcile history event opens the wine", async ({ page }) => {
    await page.goto("/cellar/reconcile/history");
    const link = page
      .locator('a[href*="/cellar?wine="]')
      .filter({ visible: true })
      .first();
    await expect(
      link,
      "/cellar/reconcile/history showed no wine link at 390px",
    ).toBeVisible();
    const wine = wineFacts(wineIdFromHref(await link.getAttribute("href")));
    await link.click();

    const scope = await wineDetailScope(page, wine.id, "reconcile history");
    await expectWineIsShown(page, scope, wine, "reconcile history → drawer");
  });

  test("a wine on the reconcile sheet opens the wine", async ({ page }) => {
    // reconcile-list.tsx:176 renders "<producer> <name> <vintage>" as a plain
    // <div> inside an <li>. item.wine_id is right there as the React key.
    await page.goto("/cellar/reconcile");
    await waitForMainContent(page, "/cellar/reconcile");
    const rows = page.locator("main li").filter({ visible: true });
    const rowCount = await countWhenSettled(page, rows);
    test.skip(rowCount === 0, "no open bottles awaiting reconciliation in the seed");

    const hrefs = await visibleWineHrefs(page.locator("main"));
    expect(
      hrefs,
      `/cellar/reconcile: ${rowCount} wines are on screen and every one is a ` +
        "plain <div> (src/app/(app)/cellar/reconcile-list.tsx:176) — item.wine_id " +
        "is already the React key at :105 and is never turned into a link",
    ).not.toEqual([]);

    const wine = wineFacts(wineIdFromHref(hrefs[0]));
    await page.locator(`main a[href="${hrefs[0]}"]`).first().click();
    const scope = await wineDetailScope(page, wine.id, "/cellar/reconcile");
    await expectWineIsShown(page, scope, wine, "/cellar/reconcile → drawer");
  });

  test("every reconcile-queue row opens its wine", async ({ page }) => {
    // issue-row.tsx:76 links the title only when row.deepLink exists, and
    // queue-sources.ts never sets it for `unplaced` or `unmatched_scan` —
    // even though the `unplaced` source already carries wineId (:119).
    await page.goto("/reconcile-queue");
    await waitForMainContent(page, "/reconcile-queue");
    const rows = page.locator("[data-queue-row]");
    const count = await countWhenSettled(page, rows);
    test.skip(count === 0, "the reconcile queue is empty in this seed");

    const inert: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if ((await row.locator("a[href]").count()) === 0) {
        inert.push((await row.getAttribute("data-queue-kind")) ?? "unknown");
      }
    }
    expect(
      inert,
      "/reconcile-queue: these row kinds show a wine with no way to open it " +
        "(src/app/(app)/reconcile-queue/issue-row.tsx:82)",
    ).toEqual([]);

    const link = rows.locator("a[href*='/cellar?wine=']").first();
    const wine = wineFacts(wineIdFromHref(await link.getAttribute("href")));
    await link.click();
    const scope = await wineDetailScope(page, wine.id, "/reconcile-queue");
    await expectWineIsShown(page, scope, wine, "/reconcile-queue → drawer");
  });

  test("a wine on a wine list opens the wine", async ({ page }) => {
    // wine-row.tsx:344 is the `md:hidden` mobile card — the only wine element
    // a phone sees on this route. It is a plain <div>; the one button on it
    // (NameEdit, wine-row.tsx:105) opens an inline rename field, so the
    // obvious "tap the wine" gesture edits it instead of showing it.
    const LIST_ID = "de100005-0000-4000-8000-000000000002";
    await page.goto(`/lists/${LIST_ID}`);
    await expect(
      page.getByRole("heading", { level: 1 }).first(),
      "the wine list did not render",
    ).toBeVisible();

    const hrefs = await visibleWineHrefs(page.locator("main"));
    expect(
      hrefs,
      "/lists/[id]: the mobile wine card is a plain <div> " +
        "(src/app/(app)/lists/[id]/components/wine-row.tsx:344) and its only " +
        "button renames the wine — there is no way to open it",
    ).not.toEqual([]);

    const wine = wineFacts(wineIdFromHref(hrefs[0]));
    await page.locator(`main a[href="${hrefs[0]}"]`).first().click();
    const scope = await wineDetailScope(page, wine.id, "/lists/[id]");
    await expectWineIsShown(page, scope, wine, "/lists/[id] wine row → detail");
  });

  test("a wine on the public list opens the wine", async ({ page }) => {
    // KNOWN GAP, DELIBERATELY OPEN — marked fixme rather than deleted so it
    // stays visible and turns green the day it is closed.
    //
    // list/[slug]/page.tsx:307 — a guest sees the bottle's thumbnail and its
    // name and can tap neither. This is the same sentence from the guest's
    // side of the table, and it is the one surface of the eighteen that cannot
    // be fixed by wiring a link: there is no public wine view to link TO.
    // Sending a guest to /cellar?wine= lands them on a login wall, which is
    // worse than an inert row. Building the view is a feature with its own auth
    // and data-exposure decisions — the `anon` grants on `wines` are
    // deliberately narrow (0142 grants exactly hero_image_url and nothing
    // else), and widening them is a product call, not a test fix.
    // Same shape at lists/[id]/preview/page.tsx:148.
    test.fixme(
      true,
      "No public wine view exists; a guest menu cannot open a wine yet.",
    );
    await page.goto("/list/local-seed-full-list");
    const thumb = page.locator("main img, img").first();
    await expect(thumb, "the public list rendered no wine").toBeVisible();

    const tappable = page
      .locator("main a[href], main button")
      .filter({ visible: true });
    const hrefs = await tappable.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") ?? "(button)"),
    );
    const wineTargets = hrefs.filter((href) => /\/cellar\/|wine=|\/wine\//.test(href));
    expect(
      wineTargets,
      "/list/[slug]: every wine row is a plain <div> " +
        "(src/app/list/[slug]/page.tsx:307) — a guest can see a bottle and its " +
        `picture but cannot open it. Tappable things on the page: ${hrefs.join(", ")}`,
    ).not.toEqual([]);
  });

  test("a wine on a committed scan opens the wine", async ({ page }) => {
    // The live route renders ScanReview (scan-review.tsx), whose mobile path
    // is LineItemCard — a plain <article> of text inputs. The richer
    // scan-detail-view.tsx, which DOES link to /cellar?wine=, is imported by
    // nothing.
    await page.goto("/scans");
    const scanLink = page
      .locator('a[href^="/scan/"]')
      .filter({ visible: true })
      .first();
    await expect(scanLink, "/scans listed no scan to open").toBeVisible();
    await scanLink.click();
    await page.waitForURL("**/scan/**");
    await waitForMainContent(page, "/scan/[id]");

    const hrefs = await visibleWineHrefs(page.locator("main"));
    expect(
      hrefs,
      "/scan/[id]: the mobile line-item card is a plain <article> " +
        "(src/app/(app)/scan/components/scan-review.tsx:322 → line-item-card.tsx:44) " +
        "— wines are listed with no way to open any of them. The richer " +
        "scan-detail-view.tsx, which DOES link to /cellar?wine=, is imported by nothing",
    ).not.toEqual([]);

    const wine = wineFacts(wineIdFromHref(hrefs[0]));
    await page.locator(`main a[href="${hrefs[0]}"]`).first().click();
    const scope = await wineDetailScope(page, wine.id, "/scan/[id]");
    await expectWineIsShown(page, scope, wine, "/scan/[id] → drawer");
  });

  test("atlas drills through to a wine", async ({ page }) => {
    // Atlas shows no individual wine, so the requirement here is that its
    // drill-down lands somewhere the wines ARE openable.
    await page.goto("/atlas");
    // The chip list, not the map: the SVG country paths carry role="button"
    // but the <svg> itself intercepts the pointer, so a real finger uses the
    // chips underneath (atlas-shell.tsx:124).
    const country = page
      .locator('ul[aria-label="Countries in your cellar"] button')
      .first();
    await expect(country, "/atlas rendered no country to tap").toBeVisible();
    await country.click();

    const viewAll = page
      .getByRole("link", { name: /^View all / })
      .first();
    await expect(viewAll, "the atlas country sheet offered no way into the cellar").toBeVisible();
    await viewAll.click();

    const row = page.locator("[data-cellar-row]").first();
    await expect(row, "the atlas drill-down landed on an empty cellar").toBeVisible();
    const wine = wineFacts(await row.getAttribute("data-cellar-row"));
    await row.getByRole("button").first().click();

    const scope = await wineDetailScope(page, wine.id, "/atlas drill-down");
    await expectWineIsShown(page, scope, wine, "/atlas → cellar row → drawer");
  });
});
