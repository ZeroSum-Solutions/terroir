import { expect, test } from "@playwright/test";

test("the retired authentication URL and token cannot create a session", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const retiredRequest = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/dev-login";
  });

  await page.goto("/api/dev-login?token=retired-test-token");

  const response = await retiredRequest;
  expect(response.status()).toBe(404);
  expect(response.headers().location).toBeUndefined();
  await expect(page).toHaveURL(/\/api\/dev-login\?token=/);
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  expect(
    (await context.cookies()).filter((cookie) =>
      cookie.name.includes("auth-token"),
    ),
  ).toEqual([]);

  await page.goto("/cellar");
  await expect(page).toHaveURL(/\/login\?next=%2Fcellar$/);
  expect(
    (await context.cookies()).filter((cookie) =>
      cookie.name.includes("auth-token"),
    ),
  ).toEqual([]);

  await context.close();
});
