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

test("opens sidebar files in the current tab unless a new tab was explicitly added", async ({ page }, testInfo) => {
  await page.goto("/");
  const openFiles = async () => {
    if (testInfo.project.name.startsWith("mobile")) await page.getByRole("button", { name: "Open files" }).click();
  };

  await openFiles();
  await page.getByRole("button", { name: /Home\.md/ }).click();
  await expect(page.getByRole("tab", { name: "Home", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(1);

  await openFiles();
  await page.getByRole("button", { name: /Rust\.md/ }).click();
  await expect(page.getByRole("tab", { name: "Rust", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(1);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByRole("tab", { name: "New tab", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(2);

  await openFiles();
  await page.getByRole("button", { name: /Rust\.md/ }).click();
  await expect(page.getByRole("tab", { name: "Rust", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(1);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await openFiles();
  await page.getByRole("button", { name: /2026-09-01\.md/ }).click();
  await expect(page.getByRole("tab", { name: "2026-09-01", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(2);

  await openFiles();
  await page.getByRole("button", { name: /Rust\.md/ }).click();
  await expect(page.locator("header strong")).toHaveText("Projects/Rust.md");
  await expect(page.getByRole("tab", { name: "2026-09-01", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveCount(2);
});

test("keeps an unsaved draft when switching between explicit tabs", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Desktop multi-tab editing regression");

  await page.goto("/");
  await page.getByRole("button", { name: /Home\.md/ }).click();
  await page.locator('[aria-label="Markdown editor"] .cm-content').fill("draft retained in the Home tab");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("button", { name: /Rust\.md/ }).click();

  await page.getByRole("tab", { name: "Home", exact: true }).click();
  await expect(page.locator('[aria-label="Markdown editor"] .cm-content')).toHaveText("draft retained in the Home tab");
  await expect(page.getByText("● Unsaved")).toBeVisible();
});

test("protects an unsaved draft when its tab is closed", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Desktop multi-tab close regression");

  await page.goto("/");
  await page.getByRole("button", { name: /Home\.md/ }).click();
  await page.locator('[aria-label="Markdown editor"] .cm-content').fill("draft that must not close silently");
  await page.getByRole("button", { name: "Close Home" }).click();
  await expect(page.getByRole("heading", { name: "Close with unsaved changes?" })).toBeVisible();

  await page.getByRole("button", { name: "Keep tab" }).click();
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();

  await page.getByRole("button", { name: "Close Home" }).click();
  await page.getByRole("button", { name: "Discard & close" }).click();
  await expect(page.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");
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

test("moves a file into a folder and back to the vault root by dragging", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "HTML drag and drop is a desktop interaction");

  await page.goto("/");
  const home = page.getByRole("button", { name: /Home\.md/ });
  const projects = page.locator("summary").filter({ hasText: "Projects" });

  await home.dragTo(projects);
  await expect(page.getByRole("button", { name: /Home\.md/ })).toHaveAttribute("title", "Projects/Home.md");

  await page.getByRole("button", { name: /Home\.md/ }).dragTo(page.locator(".root-drop-target"));
  await expect(page.getByRole("button", { name: /Home\.md/ })).toHaveAttribute("title", "Home.md");
});
