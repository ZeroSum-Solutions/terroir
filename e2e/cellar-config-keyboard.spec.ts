import { expect, test } from "@playwright/test";

test("cellar sections can be reordered with the keyboard", async ({ page }) => {
  const login = await page.request.get("/api/dev-login");
  expect(login.ok(), await login.text()).toBeTruthy();

  const savedOrders: string[][] = [];
  await page.route("**/api/cellar/config", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { section_order: string[] };
      savedOrders.push(body.section_order);
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }

    await route.fulfill({
      status: 200,
      json: {
        id: "config-1",
        rows: 10,
        columns: 10,
        name: "Main Cellar",
        labels: {
          sections: [
            { id: "reds", name: "Reds" },
            { id: "whites", name: "Whites" },
            { id: "sparkling", name: "Sparkling" },
          ],
        },
      },
    });
  });

  await page.goto("/cellar/config");
  const redsHandle = page.getByRole("button", {
    name: "Drag to reorder Reds",
  });
  await expect(redsHandle).toBeVisible();

  await redsHandle.focus();
  await expect(redsHandle).toBeFocused();
  await expect
    .poll(() => redsHandle.evaluate((node) => getComputedStyle(node).outlineStyle))
    .toBe("solid");

  await redsHandle.press("ArrowDown");

  await expect.poll(() => savedOrders).toEqual([["whites", "reds", "sparkling"]]);
  await expect
    .poll(() => page.locator("li span").allTextContents())
    .toEqual(["Whites", "Reds", "Sparkling"]);
});
