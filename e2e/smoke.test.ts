import { test, expect } from "@playwright/test";

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle(/Terroir/i);
  // Check that magic link form exists
  await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
});

test("unauthenticated user redirected to login", async ({ page }) => {
  await page.goto("/cellar");
  await expect(page).toHaveURL(/\/login/);
});

test("public wine list 404 for invalid slug", async ({ page }) => {
  const response = await page.goto("/list/nonexistent-slug-12345");
  // Should show 404 or "not found" content
  const body = await page.textContent("body");
  expect(
    response?.status() === 404 || body?.toLowerCase().includes("not found"),
  ).toBeTruthy();
});
