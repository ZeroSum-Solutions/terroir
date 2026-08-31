// Headed, watchable audit of every surface that is supposed to show a bottle.
//
// Opens a real Chromium window, logs in through /api/dev-login, and walks the
// app the way a person would — clicking the toggles, opening the drawers,
// typing into the searches — pausing on each surface with a banner that names
// it and a green outline around every wine image that actually rendered.
//
// A wine image is any <img> whose resolved URL sits under the public
// wine-images bucket. "Rendered" means complete && naturalWidth > 0, so a
// broken URL counts as a miss rather than as a picture.
//
// Usage: scripts/local/dev-local.sh must already be serving :3000.
//   node scripts/local/audit-wine-imagery.mjs [--fast]

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:3000";
const BUCKET = "/storage/v1/object/public/wine-images/";
const FAST = process.argv.includes("--fast");
const PAUSE = FAST ? 700 : 2600;
const SHOTS = "docs/screenshots/imagery-audit";

const LIST_FULL = "de100005-0000-4000-8000-000000000002";
const results = [];
const netFailures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bright overlay so the run reads as a narrated demo, not a flicker. */
async function banner(page, step, title, detail) {
  await page.evaluate(
    ({ step, title, detail }) => {
      let el = document.getElementById("__audit_banner");
      if (!el) {
        el = document.createElement("div");
        el.id = "__audit_banner";
        el.style.cssText =
          "position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#111;color:#fff;" +
          "font:600 15px/1.35 ui-sans-serif,system-ui;padding:10px 16px;display:flex;gap:14px;" +
          "align-items:baseline;box-shadow:0 2px 14px rgba(0,0,0,.4);pointer-events:none";
        document.body.appendChild(el);
      }
      el.innerHTML =
        `<span style="background:#c8102e;padding:2px 9px;border-radius:99px">${step}</span>` +
        `<span>${title}</span>` +
        `<span style="font-weight:400;opacity:.7">${detail}</span>`;
    },
    { step, title, detail },
  );
}

/**
 * Make every wine image on the surface actually fetch, then wait for it.
 *
 * Two things hide an image from a naive count. next/image renders lazily, so
 * anything below the fold has never been requested — `complete` is false and
 * no load event will ever fire, which is NOT the same as broken. And several
 * surfaces scroll inside their own container rather than the document.
 *
 * So: scroll every scrollable box, flip the wine images to eager, and wait on
 * each one against a deadline. After this, `complete === false` means the
 * request genuinely never finished, and naturalWidth === 0 on a complete
 * image means the URL genuinely failed.
 */
async function settle(page, bucket, root) {
  await page.evaluate(async ({ BUCKET, ROOT }) => {
    const scope = ROOT ? document.querySelector(ROOT) : document;
    if (!scope) throw new Error(`audit scope not found: ${ROOT}`);
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));

    const boxes = [
      ROOT ? null : document.scrollingElement,
      ...[...scope.querySelectorAll("*")].filter((n) => n.scrollHeight > n.clientHeight + 40),
    ].filter(Boolean);
    for (const box of boxes.slice(0, 5)) {
      const stride = Math.max(300, box.clientHeight - 120);
      for (let y = 0; y <= box.scrollHeight; y += stride) {
        box.scrollTop = y;
        await tick(90);
      }
      box.scrollTop = 0;
    }
    await tick(200);

    const imgs = [...scope.querySelectorAll("img")].filter((i) =>
      (i.currentSrc || i.src).includes(BUCKET),
    );
    for (const i of imgs) i.loading = "eager";
    await Promise.all(
      imgs.map((i) =>
        i.complete
          ? null
          : Promise.race([
              new Promise((r) => {
                i.addEventListener("load", r, { once: true });
                i.addEventListener("error", r, { once: true });
              }),
              new Promise((r) => setTimeout(r, 6000)),
            ]),
      ),
    );
  }, { BUCKET: bucket, ROOT: root ?? null });
  await page.waitForTimeout(400);
}

/**
 * Count and outline, in the page, so the window shows exactly what counted.
 * Green = rendered. Red = the URL failed. Amber = never finished loading.
 */
async function measure(page, bucket, root) {
  return page.evaluate(({ BUCKET, ROOT }) => {
    const scope = ROOT ? document.querySelector(ROOT) : document;
    if (!scope) throw new Error(`audit scope not found: ${ROOT}`);
    const imgs = [...scope.querySelectorAll("img")].filter((i) =>
      (i.currentSrc || i.src).includes(BUCKET),
    );
    let rendered = 0;
    const failed = [];
    const pending = [];
    for (const i of imgs) {
      const url = i.currentSrc || i.src;
      let colour;
      if (i.complete && i.naturalWidth > 0) {
        rendered += 1;
        colour = "#16a34a";
      } else if (i.complete) {
        failed.push(url);
        colour = "#dc2626";
      } else {
        pending.push(url);
        colour = "#d97706";
      }
      i.style.outline = `3px solid ${colour}`;
      i.style.outlineOffset = "1px";
    }
    return { total: imgs.length, rendered, failed, pending };
  }, { BUCKET: bucket, ROOT: root ?? null });
}

async function audit(page, step, title, detail, { expect = "images", scope } = {}) {
  console.log(`  … ${step} ${title}`);
  await banner(page, step, title, detail);
  await settle(page, BUCKET, scope);
  const m = await measure(page, BUCKET, scope);
  await banner(
    page,
    step,
    title,
    `${m.rendered} bottle image${m.rendered === 1 ? "" : "s"} rendered` +
      (m.failed.length ? ` · ${m.failed.length} BROKEN` : "") +
      (m.pending.length ? ` · ${m.pending.length} never loaded` : ""),
  );
  const clean = m.failed.length === 0 && m.pending.length === 0;
  const pass = expect === "images" ? m.rendered > 0 && clean : clean;
  results.push({ step, title, detail, scope: scope ?? "whole page", ...m, expect, pass });
  const mark = pass ? "PASS" : "FAIL";
  console.log(
    `${mark}  ${String(step).padEnd(4)} ${title.padEnd(34)} rendered=${String(m.rendered).padStart(3)}` +
      `  broken=${m.failed.length}  pending=${m.pending.length}`,
  );
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${String(step).padStart(2, "0")}-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png` });
  await sleep(PAUSE);
}

const main = async () => {
  const browser = await chromium.launch({ headless: false, slowMo: FAST ? 40 : 160, args: ["--window-position=40,40"] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 950 } });
  const page = await context.newPage();

  page.on("response", (r) => {
    if (r.url().includes(BUCKET) && r.status() >= 400) netFailures.push(`${r.status()} ${r.url()}`);
  });

  console.log(`browser open — auditing ${BASE}`);
  const login = await page.request.get(`${BASE}/api/dev-login`);
  if (!login.ok() && login.status() !== 303) throw new Error(`dev-login failed: ${login.status()}`);

  // 1 — cellar, list view
  await page.goto(`${BASE}/cellar`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /cellar beyond/i }).waitFor({ timeout: 30_000 });
  await audit(page, 1, "Cellar · list view", "the main inventory list");

  // 2 — cellar, grid view (a real click on the toggle).
  // The control's accessible name is "Grid view", not "Grid". A missing
  // control is a hard failure here, never a skip: a silently skipped surface
  // is indistinguishable from a passing one, which is how a blank page keeps
  // getting reported as fine.
  await page.getByRole("button", { name: "Grid view" }).click();
  await page.waitForTimeout(800);
  // The rack map itself is an SVG of cells and counts — no pictures there by
  // design. The bottles live in the bin detail panel, so the surface that is
  // supposed to show a thumbnail only exists after a populated cell is
  // clicked. Auditing the bare map would have scored a permanent, meaningless
  // zero.
  const populatedBin = page.getByRole("button", { name: /^Bin [A-Z]\d+, \d+ bottles?$/ }).first();
  await populatedBin.waitFor({ timeout: 15_000 });
  const binName = await populatedBin.getAttribute("aria-label");
  await populatedBin.click();
  await page.waitForTimeout(1000);
  await audit(page, 2, "Cellar · grid view", `opened ${binName}`);
  await page.getByRole("button", { name: "List view" }).click();
  await page.waitForTimeout(600);

  // 3 — the wine drawer, opened by clicking a row
  await page.locator("img").first().scrollIntoViewIfNeeded().catch(() => {});
  const firstRow = page.locator('[href*="/cellar"], button, tr').filter({ hasText: /\d{4}/ });
  await page.evaluate(() => {
    const img = [...document.images].find((i) => i.src.includes("wine-images"));
    const clickable = img?.closest("button,a,tr,li,[role='button']");
    clickable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  await audit(page, 3, "Cellar · wine drawer", "clicked a wine row", { scope: '[role="dialog"]' });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // 4 — the full wine detail page
  const wineId = await page.evaluate(() => new URL(location.href).searchParams.get("wine"));
  await page.goto(`${BASE}/cellar/${wineId ?? "de100001-0000-4000-8000-000000000069"}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await audit(page, 4, "Wine detail page", "the full bottle page");

  // 5 — the assistant, answering from the cellar
  await page.goto(`${BASE}/cellar`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Ask about your cellar" }).click();
  const ask = page.getByPlaceholder("a bold red that pairs with beef…");
  await ask.waitFor();
  await ask.fill("a bold red that pairs with beef");
  await ask.press("Enter");
  await page.waitForTimeout(2500);
  await audit(page, 5, "Assistant · cellar answer", 'asked "a bold red that pairs with beef"', {
    scope: '[role="dialog"]',
  });

  // 6 — the assistant falling back to the reference corpus.
  // The query has to be one the parser UNDERSTANDS but the cellar cannot
  // satisfy, or the corpus lane never runs and this step silently audits the
  // cellar lane twice. "a sparkling from France under $40" looked like a
  // fallback and was not: it matches the Moët in stock.
  await ask.fill("a red from France under $5");
  await ask.press("Enter");
  await page.waitForTimeout(2500);
  await audit(page, 6, "Assistant · corpus fallback", 'asked "a red from France under $5" — cellar has none', {
    scope: '[role="dialog"]',
  });
  await page.keyboard.press("Escape");

  // 7 — open bottles
  await page.goto(`${BASE}/cellar/open`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await audit(page, 7, "Open bottles", "bottles currently open");

  // 8 — the morning briefing
  await page.goto(`${BASE}/insights`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await audit(page, 8, "Insights · briefing", "drink-window alert cards");

  // 9 — bins, after typing a search
  await page.goto(`${BASE}/bins`, { waitUntil: "domcontentloaded" });
  const find = page.getByLabel("Find a bottle");
  await find.waitFor({ timeout: 20_000 });
  await find.fill("ch");
  await page.waitForTimeout(2000);
  await audit(page, 9, "Bins · bottle search", 'typed "ch" into Find a bottle');

  // 10 — the list editor
  await page.goto(`${BASE}/lists/${LIST_FULL}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await audit(page, 10, "List editor · wine rows", "Full Bottle List");

  // 11 — the add-wine modal, opened and searched
  await page.getByRole("button", { name: "Add wine" }).first().click();
  const search = page.getByLabel("Search wines");
  await search.waitFor({ timeout: 15_000 });
  await search.fill("port");
  await page.waitForTimeout(2500);
  await audit(page, 11, "List editor · add wine", 'searched "port" in the add-wine modal', {
    scope: '[role="dialog"]',
  });
  await page.keyboard.press("Escape");

  // 12 — the printable preview
  await page.goto(`${BASE}/lists/${LIST_FULL}/preview`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await audit(page, 12, "List preview", "what prints for the guest");

  // 13 — price comparison
  await page.goto(`${BASE}/price-comparison`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await audit(page, 13, "Price comparison", "comparable wines across distributors", { expect: "may-be-empty" });

  // 14 — the public menu, as a guest with no session at all
  const guest = await browser.newContext({ viewport: { width: 1512, height: 950 } });
  const guestPage = await guest.newPage();
  guestPage.on("response", (r) => {
    if (r.url().includes(BUCKET) && r.status() >= 400) netFailures.push(`${r.status()} ${r.url()}`);
  });
  await guestPage.goto(`${BASE}/list/local-seed-full-list`, { waitUntil: "domcontentloaded" });
  await guestPage.waitForTimeout(2000);
  await audit(guestPage, 14, "Public menu (logged out)", "guest QR menu, anon role");

  const failed = results.filter((r) => !r.pass);
  console.log("\n──────── wine imagery audit ────────");
  console.log(`surfaces: ${results.length}   passing: ${results.length - failed.length}   failing: ${failed.length}`);
  console.log(`bottle images rendered: ${results.reduce((n, r) => n + r.rendered, 0)}`);
  console.log(`failed image requests:  ${netFailures.length}`);
  for (const f of failed) {
    console.log(`  FAIL ${f.step} ${f.title} — rendered ${f.rendered}, broken ${f.failed.length}, pending ${f.pending.length}`);
    for (const u of [...f.failed, ...f.pending].slice(0, 3)) console.log(`       ${u}`);
  }
  for (const f of netFailures.slice(0, 10)) console.log(`  NET  ${f}`);
  writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ results, netFailures }, null, 2));
  console.log(`\nscreenshots + results.json → ${SHOTS}/`);

  await sleep(FAST ? 1000 : 6000);
  await browser.close();
  process.exit(failed.length === 0 && netFailures.length === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
