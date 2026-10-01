import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const origin = "http://localhost:18767";

test.beforeEach(({}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Authentication flows are platform independent");
});

test("password login requires the configured username", async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Username").fill("someone-else");
  await page.getByLabel("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Open vault" }).click();
  await expect(page.getByRole("alert")).toHaveText("Incorrect username or password.");

  await page.getByLabel("Username").fill("tester");
  await expect(page.getByRole("button", { name: "Open vault" })).toBeEnabled({ timeout: 3000 });
  await page.getByRole("button", { name: "Open vault" }).click();
  await expect(page.getByRole("navigation", { name: "Vault files" })).toBeVisible();
  // Without "keep me signed in" the cookie ends with the browser session.
  const session = (await page.context().cookies(origin)).find(cookie => cookie.name === "owg_session");
  expect(session?.expires).toBe(-1);
});

test("keep me signed in issues a 30-day session that is remembered next time", async ({ page }) => {
  await page.goto(origin);
  await page.getByLabel("Keep me signed in for 30 days").check();
  await page.getByLabel("Username").fill("tester");
  await page.getByLabel("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Open vault" }).click();
  await expect(page.getByRole("navigation", { name: "Vault files" })).toBeVisible();
  const session = (await page.context().cookies(origin)).find(cookie => cookie.name === "owg_session");
  const days = ((session?.expires ?? 0) * 1000 - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThanOrEqual(30);

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Vault files" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Keep me signed in for 30 days")).toBeChecked();
});

test("a passkey from the shared bookmarkd database signs in", async ({ page }) => {
  const fixture = JSON.parse(readFileSync(new URL("../.e2e-passkey/credential.json", import.meta.url), "utf8"));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
  });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: { credentialId: fixture.credentialId, isResidentCredential: true, rpId: "localhost", privateKey: fixture.privateKey, userHandle: fixture.userHandle, signCount: 1 }
  });

  await page.goto(origin);
  await page.getByLabel("Keep me signed in for 30 days").check();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("navigation", { name: "Vault files" })).toBeVisible();
  const session = (await page.context().cookies(origin)).find(cookie => cookie.name === "owg_session");
  expect((session?.expires ?? 0) * 1000 - Date.now()).toBeGreaterThan(29 * 86_400_000);

  // A different authenticator's key for the same site is not accepted.
  await page.context().clearCookies();
  await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Vault files" })).toHaveCount(0);
});
