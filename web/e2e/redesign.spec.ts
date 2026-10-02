import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

const notePath = "A very long note title about connected ideas and thoughtful digital spaces.md";
const noteTitle = notePath.replace(/\.md$/, "");
const vaultName = "A personal library of connected ideas and thoughtful digital spaces";
const noteContent = "# A place for connected ideas\n\nA quiet workspace should remain readable and useful at every size.\n\n## Working notes\n\n" + "A paragraph to keep the document independently scrollable.\n\n".repeat(35);

async function mockVault(page: Page) {
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && !["127.0.0.1", "localhost"].includes(url.hostname)) externalRequests.push(url.href);
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.routeWebSocket("**/api/v1/ws", () => {});
  await page.route("**/api/v1/**", async route => {
    const endpoint = new URL(route.request().url()).pathname.replace("/api/v1/", "");
    const body = endpoint === "system"
      ? { version: "test", vault: { name: vaultName }, features: { readOnly: false, search: true, backlinks: true }, authRequired: true }
      : endpoint === "auth/session" ? { csrfToken: "test" }
      : endpoint === "tree" ? { entries: [{ name: notePath, path: notePath, type: "markdown" }] }
      : endpoint === "file" ? { path: notePath, content: noteContent, revision: { hash: "test", mtimeMs: 0 } }
      : endpoint === "backlinks" ? { items: [] }
      : endpoint === "update" ? { current: "test", installable: false, available: false, settings: { schedule: "off", weekday: 1, time: "04:00", channel: "stable" } }
      : {};
    await route.fulfill({ json: body });
  });
  return { externalRequests, pageErrors };
}

async function openNote(page: Page) {
  await expect(page.locator(".app-shell")).toBeVisible();
  const opener = page.getByRole("button", { name: "Open files", exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator(".sidebar").getByRole("button", { name: `Open ${notePath}`, exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("A place for connected ideas");
}

async function replaceDraft(page: Page, content: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(content);
  await expect(page.locator(".save-state")).toContainText("Unsaved");
}

async function openLibraryHome(page: Page) {
  const opener = page.getByRole("button", { name: "Open files", exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole("button", { name: "Library home", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-home/);
}

async function expectInsideViewport(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  expect(bounds.left, JSON.stringify(bounds)).toBeGreaterThanOrEqual(-1);
  expect(bounds.right, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.top, JSON.stringify(bounds)).toBeGreaterThanOrEqual(-1);
  expect(bounds.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.height + 1);
}

async function captureReview(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

function contrastRatio(locator: Locator) {
  return locator.evaluate(element => {
    // Resolve computed CSS colors through the browser, including color-mix().
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v); };
    const blend = (front: number[], back: number[]) => front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3]));
    const backgrounds: number[][] = [];
    for (let current: Element | null = element; current; current = current.parentElement) backgrounds.push(rgba(getComputedStyle(current).backgroundColor));
    const background = backgrounds.reverse().reduce((back, front) => blend(front, back), [255, 255, 255]);
    const foreground = blend(rgba(getComputedStyle(element).color), background);
    const luminance = (color: number[]) => color.map(channel => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((total, channel, i) => total + channel * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(foreground); const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test("library and reading surfaces remain usable in both color schemes", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  const { pageErrors } = await mockVault(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Room for a little wonder." })).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const create = page.getByRole("button", { name: "Create a note", exact: true });
    await expect(create).toBeVisible();
    await expect(create).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await captureReview(page, info, `${colorScheme}-library`);
  }
  await openNote(page);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".preview")).toContainText("A quiet workspace");
  await expect.poll(() => page.locator(".preview").evaluate(element => {
    return element.querySelector("h1")!.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }), { message: "Opening a document at its start preserves the reading margin above its title" }).toBeGreaterThanOrEqual(24);
  await captureReview(page, info, "dark-reading");
  expect(pageErrors).toEqual([]);
});

test("login exposes reachable authentication controls in both color schemes", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  const { pageErrors } = await mockVault(page);
  await page.route("**/api/v1/system", route => route.fulfill({ json: {
    version: "test", vault: { name: vaultName }, features: { readOnly: false, search: true, backlinks: true },
    authRequired: true, auth: { password: true, username: true, passkey: true }
  } }));
  await page.route("**/api/v1/auth/session", route => route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Open vault", exact: true })).toBeDisabled();
    await expectInsideViewport(page.locator(".login-form-heading"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await captureReview(page, info, `${colorScheme}-login`);
  }
  await page.getByLabel("Username").fill("reader");
  await page.getByLabel("Password", { exact: true }).fill("a-local-test-password");
  const submit = page.getByRole("button", { name: "Open vault", exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expectInsideViewport(submit);
  await expect(submit).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test("long names retain reachable document controls across responsive layouts", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const { pageErrors } = await mockVault(page);
  await page.setViewportSize({ width: mobile ? 390 : 1440, height: 900 });
  await page.goto("/");
  await openNote(page);

  for (const width of mobile ? [320, 390] : [768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const contextClose = page.getByRole("button", { name: "Hide context panel", exact: true });
    if (await contextClose.isVisible()) await contextClose.click();
    for (const name of ["Edit", "Preview", "Toggle context panel", "Sign out", "Save", "Note actions"]) {
      await expectInsideViewport(page.getByRole("button", { name, exact: true }));
    }
    await expectInsideViewport(page.locator(".document-toolbar"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator(".preview")).toContainText("A quiet workspace");
    await expectInsideViewport(page.locator(".preview"));
    await page.getByRole("button", { name: "Edit", exact: true }).click();
  }
  expect(pageErrors).toEqual([]);
});

test("home and editor use local resources and honor reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { externalRequests, pageErrors } = await mockVault(page);
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  const excessiveMotion = await page.evaluate(() => [...document.querySelectorAll("*")].flatMap(element => {
    return [null, "::before", "::after"].flatMap(pseudo => {
      const style = getComputedStyle(element, pseudo);
      const seconds = (value: string) => value.split(",").map(duration => parseFloat(duration) * (duration.trim().endsWith("ms") ? 0.001 : 1));
      return Math.max(...seconds(style.animationDuration), ...seconds(style.transitionDuration)) > 0.05
        ? [`${element.tagName}.${element.className}${pseudo ?? ""}`] : [];
    });
  }));
  expect(excessiveMotion).toEqual([]);
  await openNote(page);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".preview")).toContainText("A quiet workspace");
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("essential reading and action text retain contrast in light and dark schemes", async ({ page }) => {
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nA new thought.");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const selector of [".document-location strong", ".preview p", ".document-toolbar .primary-button"]) {
      await expect.poll(() => contrastRatio(page.locator(selector).first()), { message: `${colorScheme} ${selector}` }).toBeGreaterThanOrEqual(4.5);
    }
  }
  await openLibraryHome(page);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const selector of [".home-search", ".workspace-tab:not(.active) .tab-button", ".home-featured-bottom > span:first-child"]) {
      await expect.poll(() => contrastRatio(page.locator(selector).first()), { message: `${colorScheme} ${selector}` }).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("focus mode preserves the editor and draft and has a reachable exit", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const mobileViewport = page.viewportSize();
  if (mobile) await page.setViewportSize({ width: 1440, height: 900 });
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await replaceDraft(page, "My draft stays here while I focus.");
  await page.locator(".cm-content").evaluate(element => { element.dataset.identity = "original-editor"; });
  await page.getByRole("button", { name: "Enter focus mode", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/focus-mode/);
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", true);
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.locator(".tab-strip")).toBeHidden();
  await expect(page.locator(".cm-content")).toHaveAttribute("data-identity", "original-editor");
  await expectInsideViewport(page.getByRole("button", { name: "Exit focus mode", exact: true }));
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
  await expect(page.locator(".tab-strip")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText("My draft stays here while I focus.");
  await expect(page.locator(".cm-content")).toHaveAttribute("data-identity", "original-editor");
  await expect(page.locator(".save-state")).toContainText("Unsaved");

  if (mobile) {
    // A desktop focus session can resize into mobile. Opening navigation must
    // not leave an invisible, inert drawer covering its own exit controls.
    await page.getByRole("button", { name: "Enter focus mode", exact: true }).click();
    await page.setViewportSize(mobileViewport!);
    await page.getByRole("button", { name: "Open files", exact: true }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
    await expect(page.locator(".sidebar")).toHaveJSProperty("inert", false);
    await expect(page.getByLabel("Search vault")).toBeVisible();
    await page.locator(".sidebar").getByRole("button", { name: "Close files", exact: true }).click();
    await expect(page.locator(".cm-content")).toHaveText("My draft stays here while I focus.");
  }
});

test("Library home keeps dirty notes and reuses its existing tab", async ({ page }) => {
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await replaceDraft(page, "An unsaved idea must survive the trip home.");
  await openLibraryHome(page);
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const tabs = page.getByRole("tablist", { name: "Open notes", exact: true }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await openLibraryHome(page);
  await expect(tabs).toHaveCount(2);
  await page.getByRole("tab", { name: noteTitle, exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("An unsaved idea must survive the trip home.");
  await expect(page.locator(".save-state")).toContainText("Unsaved");
  await expect(page.getByRole("tab", { name: noteTitle, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: noteTitle, exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".app-shell")).toHaveClass(/is-home/);
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: noteTitle, exact: true })).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("An unsaved idea must survive the trip home.");
  await expect(page.locator(".save-state")).toContainText("Unsaved");
});

test("split focus keeps readable panes and context actions open on their first click", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("mobile"), "Split mode is a desktop workspace feature");
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const contextToggle = page.getByRole("button", { name: "Toggle context panel", exact: true });
  await contextToggle.click();
  await expect(page.locator(".context-panel")).toBeVisible();
  await page.getByRole("button", { name: "Enter focus mode", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/focus-mode/);
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.locator(".document-panes")).toHaveClass(/is-split/);
  for (const selector of [".cm-content", ".preview"]) {
    await expect.poll(() => page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }), { message: `${selector} keeps a readable column when split and focus modes are combined` }).toBeGreaterThanOrEqual(250);
  }
  await captureReview(page, info, "focus-split");

  // The context was open before focus mode hid it; one click must reopen it.
  await contextToggle.click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
  await expect(page.locator(".context-panel")).toBeVisible();
  await expect(contextToggle).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Enter focus mode", exact: true }).click();
  await page.getByRole("button", { name: "Note actions", exact: true }).click();
  await page.getByRole("button", { name: "Outline & backlinks", exact: true }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
  await expect(page.locator(".context-panel")).toBeVisible();
  await expect(page.locator(".note-menu-popover")).toHaveCount(0);

  await page.getByRole("button", { name: "Enter focus mode", exact: true }).click();
  await page.route("**/api/v1/tree", route => route.fulfill({ json: { entries: [] } }));
  await page.getByRole("button", { name: "Note actions", exact: true }).click();
  await page.getByRole("button", { name: "Move note to trash", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-home/);
  await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", false);
  await expect(page.locator(".tab-strip")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every library begins with a thought.", exact: true })).toBeVisible();
});

test("mobile outline navigation closes its overlay and focuses the reading heading", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "Mobile context is a modal overlay");
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Toggle context panel", exact: true }).click();
  await page.locator(".outline-list").getByRole("button", { name: /Working notes/ }).click();
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.locator(".workspace")).toHaveJSProperty("inert", false);
  const heading = page.locator(".preview").getByRole("heading", { name: "Working notes", exact: true });
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
});

test("mobile navigation excludes hidden controls and quick search replaces context", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "Mobile drawers have a distinct keyboard boundary");
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", true);
  await page.getByRole("button", { name: "Open files", exact: true }).focus();
  for (let count = 0; count < 8; count++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".sidebar"))).toBe(false);
  }
  const contextToggle = page.getByRole("button", { name: "Toggle context panel", exact: true });
  await contextToggle.click();
  await expect(page.locator(".context-panel")).toBeVisible();
  await expect(page.locator(".topbar")).toHaveJSProperty("inert", true);
  await expect(page.locator(".workspace")).toHaveJSProperty("inert", true);
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", false);
  await expect(page.getByLabel("Search vault")).toBeFocused();
  const close = page.locator(".sidebar").getByRole("button", { name: "Close files", exact: true });
  const first = page.locator(".sidebar").getByRole("button", { name: /About and updates/ });
  const last = page.getByRole("button", { name: "New folder", exact: true });
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await close.click();
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", true);
  await expect(page.locator(".topbar")).toHaveJSProperty("inert", false);
  await expect(page.locator(".workspace")).toHaveJSProperty("inert", false);
});

test("resizing a desktop context panel into an overlay protects keyboard focus", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("mobile"), "Desktop-to-tablet breakpoint transition");
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await expect(page.locator(".context-panel")).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.locator(".topbar")).toHaveJSProperty("inert", true);
  await expect(page.locator(".workspace")).toHaveJSProperty("inert", true);
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", true);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".context-panel"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.locator(".topbar")).toHaveJSProperty("inert", false);
  await expect(page.locator(".workspace")).toHaveJSProperty("inert", false);
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", false);
});

test("preview content is not rebuilt when unrelated workspace state changes", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "Desktop context panel toggles without an overlay");
  await mockVault(page);
  await page.goto("/");
  await openNote(page);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const heading = page.locator(".preview").getByRole("heading", { name: "Working notes", exact: true });
  await heading.evaluate(element => { (element as HTMLElement & { marker?: boolean }).marker = true; });
  // Toggling the context panel re-renders the workspace but not the Markdown.
  await page.getByRole("button", { name: "Toggle context panel", exact: true }).click();
  await page.getByRole("button", { name: "Toggle context panel", exact: true }).click();
  expect(await heading.evaluate(element => (element as HTMLElement & { marker?: boolean }).marker === true)).toBe(true);
});

test("the file tree keeps its room on shorter desktop screens", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "Desktop sidebar layout");
  await page.setViewportSize({ width: 1280, height: 720 });
  await mockVault(page);
  await page.goto("/");
  await expect(page.locator(".sidebar-colophon")).toBeHidden();
  expect(await page.locator(".sidebar-scroll").evaluate(element => element.clientHeight)).toBeGreaterThan(250);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".sidebar-colophon")).toBeVisible();
});
