import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type Role = "owner" | "manager" | "staff" | "guest";
type RoutePolicy = {
  source: string;
  path: string;
  roles: Role[];
  samplePathEnvironment?: string;
};
type ControlPolicy = {
  routes: RoutePolicy[];
};
type CrawlFinding = {
  route: string;
  message: string;
};

const isEnabled = process.env.TERROIR_UI_CRAWL === "1";
const requireAllRoles = process.env.UI_CRAWL_REQUIRE_ALL_ROLES === "1";
const policy = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "docs/ui-control-policy.json"), "utf8"),
) as ControlPolicy;

const storageStateEnvironment: Record<Exclude<Role, "guest">, string> = {
  owner: "UI_CRAWL_OWNER_STORAGE_STATE",
  manager: "UI_CRAWL_MANAGER_STORAGE_STATE",
  staff: "UI_CRAWL_STAFF_STORAGE_STATE",
};

function routeSample(route: RoutePolicy): string | null {
  if (!route.path.includes(":")) return route.path;
  const sample = route.samplePathEnvironment
    ? process.env[route.samplePathEnvironment]
    : undefined;
  if (!sample) return null;
  return route.path.replace(/:[^/]+/g, encodeURIComponent(sample));
}

function accessibleLabel(element: { text: string; ariaLabel: string | null; title: string | null }) {
  return element.ariaLabel?.trim() || element.title?.trim() || element.text.trim();
}

async function inspectRuntimeControls(page: Page, route: string, findings: CrawlFinding[]) {
  const controls = await page.locator("a[href], button, form, input:not([type=hidden]), select, textarea").evaluateAll(
    (elements) => elements.map((element) => ({
      tag: element.tagName.toLowerCase(),
      text: element.textContent ?? "",
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      placeholder: element.getAttribute("placeholder"),
      href: element.getAttribute("href"),
      disabled: "disabled" in element && Boolean((element as HTMLButtonElement).disabled),
    })),
  );

  for (const control of controls) {
    if (
      control.tag !== "form"
      && control.tag !== "input"
      && control.tag !== "select"
      && control.tag !== "textarea"
      && !accessibleLabel(control)
    ) {
      findings.push({ route, message: `${control.tag} has no accessible label` });
    }
    if (control.href === "#" || control.href === "javascript:void(0)") {
      findings.push({ route, message: `dead runtime href ${control.href}` });
    }
  }

  return controls;
}

async function probeInternalLinks(
  context: BrowserContext,
  page: Page,
  route: string,
  findings: CrawlFinding[],
) {
  const currentOrigin = new URL(page.url()).origin;
  const hrefs = await page.locator("a[href]").evaluateAll((links) =>
    [...new Set(links.map((link) => (link as HTMLAnchorElement).href))],
  );

  for (const href of hrefs) {
    const url = new URL(href);
    if (url.origin !== currentOrigin || !["http:", "https:"].includes(url.protocol)) continue;
    const probe = await context.newPage();
    const probeErrors: string[] = [];
    probe.on("pageerror", (error) => probeErrors.push(error.message));
    try {
      const response = await probe.goto(url.toString(), { waitUntil: "domcontentloaded" });
      if (!response || response.status() >= 400) {
        findings.push({ route, message: `${url.pathname} returned ${response?.status() ?? "no response"}` });
      }
      for (const error of probeErrors) {
        findings.push({ route, message: `${url.pathname} page error: ${error}` });
      }
    } finally {
      await probe.close();
    }
  }
}

test.describe("TER-006 visible-control and dead-link crawl", () => {
  test.skip(!isEnabled, "Run explicitly with pnpm run test:ui-crawl against isolated fixtures.");

  for (const role of policy.routes.flatMap((route) => route.roles).filter((value, index, all) => all.indexOf(value) === index)) {
    const environmentName = role === "guest" ? null : storageStateEnvironment[role];
    const storageState = environmentName ? process.env[environmentName] : undefined;
    const roleTest = environmentName && !storageState && !requireAllRoles ? test.skip : test;
    roleTest(`${role} route and action inventory has no dead surface`, async ({ browser, baseURL }, testInfo) => {
      if (environmentName && !storageState) throw new Error(`${environmentName} is required`);

      const context = await browser.newContext({ storageState, baseURL });
      const page = await context.newPage();
      const findings: CrawlFinding[] = [];
      const visitedRoutes: string[] = [];
      const missingSamples: string[] = [];

      try {
        for (const configuredRoute of policy.routes.filter((route) => route.roles.includes(role))) {
          const route = routeSample(configuredRoute);
          if (!route) {
            missingSamples.push(configuredRoute.samplePathEnvironment ?? configuredRoute.path);
            continue;
          }
          visitedRoutes.push(route);
          const pageErrors: string[] = [];
          const responseErrors: string[] = [];
          const onPageError = (error: Error) => pageErrors.push(error.message);
          const onResponse = (response: { url(): string; status(): number }) => {
            const url = new URL(response.url());
            if (url.origin === new URL(page.url()).origin && response.status() >= 400) {
              responseErrors.push(`${url.pathname} returned ${response.status()}`);
            }
          };
          page.on("pageerror", onPageError);
          page.on("response", onResponse);

          const response = await page.goto(route, { waitUntil: "networkidle" });
          if (!response || response.status() >= 400) {
            findings.push({ route, message: `route returned ${response?.status() ?? "no response"}` });
          }
          await inspectRuntimeControls(page, route, findings);
          await probeInternalLinks(context, page, route, findings);
          for (const error of pageErrors) findings.push({ route, message: `page error: ${error}` });
          for (const error of responseErrors) findings.push({ route, message: error });
          page.off("pageerror", onPageError);
          page.off("response", onResponse);
        }
      } finally {
        await context.close();
      }

      if (requireAllRoles && missingSamples.length > 0) {
        findings.push({ route: "preflight", message: `missing sample values: ${missingSamples.join(", ")}` });
      }
      await testInfo.attach("ui-control-crawl-report.json", {
        body: JSON.stringify({ role, visitedRoutes, missingSamples, findings }, null, 2),
        contentType: "application/json",
      });
      expect(findings).toEqual([]);
    });
  }
});
