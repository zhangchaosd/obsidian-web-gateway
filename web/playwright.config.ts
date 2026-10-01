import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:18766",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "cargo run --manifest-path ../Cargo.toml -- --vault ../tests/fixtures/basic --listen 127.0.0.1:18766 --no-auth",
      url: "http://127.0.0.1:18766/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      // Password + passkey login against a bookmarkd-format database (see e2e/passkey-fixture.mjs).
      command: "node e2e/passkey-fixture.mjs && cargo run --manifest-path ../Cargo.toml -- --vault ../tests/fixtures/basic --listen 127.0.0.1:18767 --read-only --public-url http://localhost:18767 --passkey-db .e2e-passkey/auth.db --username tester --password e2e-password --data-dir .e2e-passkey/data",
      url: "http://127.0.0.1:18767/health",
      reuseExistingServer: false,
      timeout: 120_000
    }
  ],
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }
  ]
});
