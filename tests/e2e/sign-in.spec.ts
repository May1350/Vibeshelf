import { test, expect } from "@playwright/test"

test("sign-in page renders with GitHub button", async ({ page }) => {
  await page.goto("/")

  // Verify the page loads with the expected content
  await expect(page.getByText("VibeShelf")).toBeVisible()

  // Verify the sign-in button exists and links to Supabase Auth
  const signInLink = page.getByRole("link", { name: /sign in with github/i })
  await expect(signInLink).toBeVisible()

  // Verify the link points to the Supabase auth endpoint
  const href = await signInLink.getAttribute("href")
  expect(href).toContain("/auth/v1/authorize")
  expect(href).toContain("provider=github")
})
