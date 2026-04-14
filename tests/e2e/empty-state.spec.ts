import { expect, test } from "@playwright/test";

test("empty state shows recommendations when no results", async ({ page }) => {
  await page.goto("/?q=zzznomatchexpected");
  await expect(page.locator("h2#no-results-heading")).toBeVisible();
  await expect(page.locator('a:has-text("Clear all filters")')).toBeVisible();
});
