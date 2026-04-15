import { expect, test } from "@playwright/test";

test.describe("marketplace home — desktop", () => {
  test("renders grid + sidebar + sort", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("VibeShelf");
    await expect(page.locator("aside form")).toBeVisible();
    await expect(page.locator('[role="img"][aria-label*="Quality"]').first()).toBeVisible();
  });

  test("clicking a category filter updates URL and grid", async ({ page }) => {
    await page.goto("/");
    // Multi-select checkbox (name="categories"); URL uses `?categories=saas`.
    await page.locator('input[name="categories"][value="saas"]').check();
    await page.waitForURL(/categories=saas/);
    await expect(page.locator("[role='status']")).toContainText("템플릿");
  });

  test("pagination link navigates", async ({ page }) => {
    await page.goto("/?page=1");
    const page2Link = page.locator('a[aria-label*="2 페이지로 이동"]');
    if ((await page2Link.count()) > 0) {
      await page2Link.first().click();
      await page.waitForURL(/page=2/);
    }
  });
});
