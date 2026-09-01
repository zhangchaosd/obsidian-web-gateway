import { expect, test } from "@playwright/test";

test("opens notes, renders Wiki Links, embeds, and responsive navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Obsidian Web Gateway");

  if (testInfo.project.name.startsWith("mobile")) {
    await page.getByRole("button", { name: "Open files" }).click();
  }
  await page.getByRole("button", { name: /Home\.md/ }).click();
  await expect(page.getByText("✓ Saved")).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.locator("article img")).toHaveAttribute("src", /attachments%2Ftiny\.svg/);

  await page.getByRole("button", { name: "Rust Notes" }).click();
  await expect(page.locator("header strong")).toHaveText("Projects/Rust.md");
  await expect(page.getByText("Safe systems programming.", { exact: true })).toBeVisible();
});
