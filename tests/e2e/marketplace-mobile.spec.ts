import { expect, test } from "@playwright/test";

test.describe("marketplace home — mobile", () => {
  test("filter drawer opens on Filters button click", async ({ page }) => {
    await page.goto("/");
    const trigger = page.locator('button:has-text("Filters")');
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.locator("[role='dialog']")).toBeVisible();
  });
});
