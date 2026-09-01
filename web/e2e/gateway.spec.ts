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

test("keeps the save toolbar visible while a long unsaved note scrolls", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Desktop editor layout regression");

  await page.goto("/");
  await page.getByRole("button", { name: /Home\.md/ }).click();

  const editor = page.locator('[aria-label="Markdown editor"] .cm-content');
  await editor.fill(Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n"));
  await expect(page.getByText("● Unsaved")).toBeVisible();

  const toolbar = page.locator(".document-toolbar");
  const scroller = page.locator(".cm-scroller");
  const toolbarTop = await toolbar.evaluate(element => element.getBoundingClientRect().top);
  const scrollMetrics = await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    const editor = element.closest(".cm-editor");
    const surface = element.closest(".editor-surface");
    const pane = element.closest(".editor-pane");
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      editorHeight: editor?.getBoundingClientRect().height,
      surfaceHeight: surface?.getBoundingClientRect().height,
      paneHeight: pane?.getBoundingClientRect().height
    };
  });

  expect(scrollMetrics.scrollHeight, JSON.stringify(scrollMetrics)).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.scrollTop, JSON.stringify(scrollMetrics)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  expect(await toolbar.evaluate(element => element.getBoundingClientRect().top)).toBe(toolbarTop);
});

test("warns before leaving with unsaved changes", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Browser lifecycle regression");

  await page.goto("/");
  await page.getByRole("button", { name: /Home\.md/ }).click();
  await page.locator('[aria-label="Markdown editor"] .cm-content').fill("unsaved content");
  await expect(page.getByText("● Unsaved")).toBeVisible();

  const dialogPromise = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();

  expect(page.isClosed()).toBe(false);
  await expect(page.getByText("● Unsaved")).toBeVisible();
});
