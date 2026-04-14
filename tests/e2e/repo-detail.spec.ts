import { expect, test } from "@playwright/test";

test("repo detail page renders score breakdown + JSON-LD + fork CTA", async ({ page }) => {
  // Assumes seed-dev created a fixture-01/template-1 repo (see scripts/seed-dev.ts).
  await page.goto("/r/fixture-01/template-1");
  await expect(page.locator("h1")).toContainText("template-1");
  await expect(page.locator('[aria-labelledby="score-breakdown-heading"]')).toBeVisible();
  await expect(page.locator('script[type="application/ld+json"]')).toBeAttached();
  await expect(page.locator('a:has-text("View on GitHub")')).toBeVisible();
});

test("non-existent repo returns 404", async ({ page }) => {
  const res = await page.goto("/r/does-not-exist/anywhere");
  expect(res?.status()).toBe(404);
});
