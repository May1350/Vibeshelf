import { expect, test } from "@playwright/test";

test.use({ javaScriptEnabled: false });

test.describe("marketplace — no JS fallback", () => {
  test("filter form submits via GET on Apply button", async ({ page }) => {
    await page.goto("/");
    // Without JS, checking a categories checkbox shouldn't auto-submit; user
    // must click Apply. Multi-category form field name is "categories".
    await page.locator('input[name="categories"][value="saas"]').check();
    await page.locator('button[type="submit"]').first().click();
    await expect(page).toHaveURL(/categories=saas/);
  });
});
