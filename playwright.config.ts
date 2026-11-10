import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["PORT"] ?? 4317);
const baseURL = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  // No retries anywhere: a flake is a bug to fix, not to hide.
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Off: in WebKit a Playwright screenshot injects an inline <style> (caret and animation hiding), which the strict CSP
    // refuses, so the guard would fail every test. Traces still carry DOM snapshots of a failure.
    screenshot: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node examples/demo/server.ts",
    url: `${baseURL}/healthz`,
    env: { PORT: String(PORT), DEMO_TEST_HOOKS: "1" },
    reuseExistingServer: !CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  },
});
