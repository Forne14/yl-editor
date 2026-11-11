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
    // Capped at 2 (#24): with Playwright 1.65.0 (Firefox 159.0, revision 1572) the Firefox content process segfaults
    // when several Firefox workers start at once on a loaded machine; every macOS crash report is the same null write
    // in XUL. Local runs default to more workers, so this lowers the pressure there. CI already runs 2 workers in
    // total, so it changes nothing on CI. Retest after a Playwright upgrade and drop the cap once the crash is gone.
    { name: "firefox", workers: 2, use: { ...devices["Desktop Firefox"] } },
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
