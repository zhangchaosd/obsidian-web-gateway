import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

async function replaceDraft(page: Page, text: string) {
  // Use the editor's select-all binding; DOM fill does not select CodeMirror's
  // complete document under Android's virtualized contenteditable handling.
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  if (!text.includes("\n")) await expect(page.locator(".cm-content")).toHaveText(text);
  else await expect(page.locator(".save-state")).toContainText("Unsaved");
}

async function workspace(page: Page, mobile: boolean) {
  const files = new Map([
    ["A.md", { content: "# Alpha\n\nOriginal note.\n\n" + "Paragraph.\n\n".repeat(35) + "## Destination\n\nLast section.", hash: "a1" }],
    ["B.md", { content: "# Beta\n\nSecond note.", hash: "b1" }]
  ]);
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/v1/ws", ws => { socket = ws; });
  await page.route("**/api/v1/**", async route => {
    const request = route.request(); const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1/", "");
    let body: unknown = {};
    if (path === "system") body = { version: "test", vault: { name: "Notebook" }, features: { readOnly: false, search: true, backlinks: true }, authRequired: true };
    else if (path === "auth/session") body = { csrfToken: "test" };
    else if (path === "auth/logout") return route.fulfill({ status: 204 });
    else if (path === "tree") body = { entries: [...files.keys()].map(path => ({ name: path, path, type: "markdown" })) };
    else if (path === "backlinks") body = { items: [] };
    else if (path === "search") body = { results: [] };
    else if (path === "files") { const data = request.postDataJSON(); files.set(data.path, { content: data.content, hash: "new" }); body = { path: data.path, revision: { hash: "new", mtimeMs: 0 } }; }
    else if (path === "file") {
      if (request.method() === "PUT") {
        const data = request.postDataJSON(); const disk = files.get(data.path);
        if (!data.force && disk?.hash !== data.baseRevision.hash) return route.fulfill({ status: 409, json: { error: "revision_conflict", message: "Conflict" } });
        const hash = `${Date.now()}`; files.set(data.path, { content: data.content, hash }); body = { path: data.path, revision: { hash, mtimeMs: 0 } };
      } else {
        const path = url.searchParams.get("path")!; const file = files.get(path);
        if (!file) return route.fulfill({ status: 404, json: { error: "not_found" } });
        body = { path, content: file.content, revision: { hash: file.hash, mtimeMs: 0 } };
      }
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  const open = async (name: string) => {
    if (mobile) await page.getByRole("button", { name: "Open files", exact: true }).click();
    await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  };
  await open("A.md");
  await expect(page.locator(".cm-content")).toContainText("Original note.");
  return {
    open, files,
    change(path: string, content: string) {
      files.set(path, { content, hash: `external-${Date.now()}` });
      if (!socket) throw new Error("WebSocket not connected");
      socket.send(JSON.stringify({ type: "file.changed", payload: { path } }));
    }
  };
}

test("new note keeps the current draft until the user chooses to leave", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  const state = await workspace(page, mobile);
  await replaceDraft(page, "My irreplaceable draft");
  if (mobile) await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Note path").fill("Created");
  await page.getByRole("button", { name: "Create note", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Save your changes?");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  if (mobile) await page.locator(".sidebar").getByRole("button", { name: "Close files", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("My irreplaceable draft");
  await expect(page.getByRole("tab", { name: "A", exact: true })).toBeVisible();
  await state.open("Created.md");
  await page.getByRole("button", { name: "Save & open", exact: true }).click();
  await expect(page.locator("header strong")).toHaveText("Created.md");
  expect(state.files.get("A.md")?.content).toBe("My irreplaceable draft");
  await expect(page.locator(".cm-content")).toContainText("# Created");
});

test("background tabs receive disk updates while dirty drafts are retained", async ({ page }, info) => {
  const state = await workspace(page, info.project.name.startsWith("mobile"));
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await state.open("B.md");
  const firstUpdate = page.waitForResponse("**/api/v1/file?path=A.md");
  state.change("A.md", "# Alpha\n\nExternal update");
  await firstUpdate;
  await expect(page.locator("header strong")).toHaveText("B.md");
  await page.getByRole("tab", { name: "A", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("External update");
  await replaceDraft(page, "Draft survives external changes");
  await page.getByRole("tab", { name: "B", exact: true }).click();
  const secondUpdate = page.waitForResponse("**/api/v1/file?path=A.md");
  state.change("A.md", "# Alpha\n\nAnother external update");
  await secondUpdate;
  await page.getByRole("tab", { name: "A", exact: true }).click();
  await expect(page.locator(".conflict")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText("Draft survives external changes");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.locator(".diff-view")).toContainText("Another external update");
});

test("empty searches show an explicit result and can return to files", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await workspace(page, mobile);
  if (mobile) await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.getByLabel("Search vault").fill("not-in-vault");
  await page.getByLabel("Search vault").press("Enter");
  await expect(page.getByText("No notes found", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open A.md", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "All files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open A.md", exact: true })).toBeVisible();
});

test("outline navigates reading and editing modes on desktop and mobile", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await workspace(page, mobile);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  if (mobile) await page.getByRole("button", { name: "Toggle context panel", exact: true }).click();
  await page.locator(".outline-list").getByRole("button", { name: /Destination/ }).click();
  await expect(page.getByRole("heading", { name: "Destination", exact: true })).toBeInViewport();
  expect(await page.locator(".preview").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  if (mobile) await page.getByRole("button", { name: "Toggle context panel", exact: true }).click();
  await page.locator(".outline-list").getByRole("button", { name: /Destination/ }).click();
  await expect(page.locator(".cm-activeLine")).toHaveText("## Destination");
});

test("dialogs contain keyboard focus and signing out protects drafts", async ({ page }, info) => {
  await workspace(page, info.project.name.startsWith("mobile"));
  await replaceDraft(page, "Keep this before signing out");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Sign out with unsaved changes?");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
  await expect(page.locator(".cm-content")).toHaveText("Keep this before signing out");
});

test("out-of-order file requests cannot replace the latest selection", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await workspace(page, mobile);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested: () => void = () => {};
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/api/v1/file?path=B.md", async route => {
    requested(); await gate;
    await route.fulfill({ json: { path: "B.md", content: "# Late Beta", revision: { hash: "late", mtimeMs: 0 } } });
  });
  if (mobile) await page.getByRole("button", { name: "Open files", exact: true }).click();
  await page.getByRole("button", { name: "Open B.md", exact: true }).click();
  await started;
  // A is already open; selecting it must invalidate the pending replacement.
  await page.getByRole("button", { name: "Open A.md", exact: true }).click();
  const response = page.waitForResponse("**/api/v1/file?path=B.md");
  release();
  await response;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("header strong")).toHaveText("A.md");
  await expect(page.locator(".cm-content")).toContainText("Original note.");
});

test("split preview updates unsaved drafts, preserves scroll, and resizes without resetting the editor", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("mobile"), "Split view is a desktop layout");
  const state = await workspace(page, false);
  const original = state.files.get("A.md")!.content;
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
  await page.locator(".cm-content").evaluate(element => { element.dataset.identity = "same-editor"; });
  const divider = page.getByRole("separator", { name: "Resize editor and preview" });
  await divider.focus(); await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "52");
  await expect(page.locator(".cm-content")).toHaveAttribute("data-identity", "same-editor");
  await replaceDraft(page, original + "\nUNSAVED LIVE UPDATE\n");
  await expect(page.locator(".preview")).toContainText("UNSAVED LIVE UPDATE");
  expect(state.files.get("A.md")!.content).toBe(original);
  const scrollTop = await page.locator(".preview").evaluate(element => { element.scrollTop = 240; return element.scrollTop; });
  await page.locator(".cm-content").press("ControlOrMeta+End");
  await page.keyboard.insertText("Another draft update");
  await expect(page.locator(".preview")).toContainText("Another draft update");
  expect(await page.locator(".preview").evaluate(element => element.scrollTop)).toBe(scrollTop);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveAttribute("data-identity", "same-editor");
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator(".preview")).toContainText("Another draft update");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Split", exact: true })).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveAttribute("data-identity", "same-editor");
});

test("preview copies only the selected code block, preserving whitespace and special characters", async ({ page }, info) => {
  const mobile = info.project.name.startsWith("mobile");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  });
  await workspace(page, mobile);
  const code = 'const value = "<tag>&中文";\n  console.log(value);\n';
  await replaceDraft(page, '# Code\n\n```js\n' + code + '```\n\n    second block\n');
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const first = page.locator(".code-block").first();
  const copy = first.getByRole("button", { name: "Copy code", exact: true });
  if (!mobile) { await expect(copy).toHaveCSS("opacity", "0"); await first.hover(); }
  await expect(copy).toHaveCSS("opacity", "1");
  await copy.click();
  await expect(first.getByRole("button", { name: "Code copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(code);
  const second = page.locator(".code-block").nth(1);
  if (!mobile) await second.hover();
  await second.getByRole("button", { name: "Copy code", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe("second block\n");
});

test("copy failures show actionable feedback rather than reporting success", async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    document.execCommand = () => false;
  });
  await workspace(page, info.project.name.startsWith("mobile"));
  await replaceDraft(page, '```\ncopy me\n```');
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const button = page.getByRole("button", { name: "Copy code", exact: true });
  await button.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Copy failed. Select the code and copy manually.", exact: true })).toBeVisible();
  await expect(page.locator(".clipboard-buffer")).toHaveCount(0);
});
