import { defineConfig, devices } from "@playwright/test";
import { DEFAULT_VIEWPORT } from "./tests/viewport-policy";

/**
 * The three zones the journeys run in, and the coverage boundary around them.
 *
 * `globalSetup` empties `coverage/raw` before any worker starts (a leftover file from
 * an earlier run would be merged into this one and the numbers would be a mixture of
 * two runs). `globalTeardown` is where the coverage report and the group floors are
 * applied: it runs once after every worker has exited, so a red journey still leaves
 * a report, and a breached floor still fails the run. Both live in `tests/` beside the
 * collector (`frontend-coverage.ts`) every journey imports.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/frontend-coverage-setup.mjs",
  globalTeardown: "./tests/frontend-coverage-teardown.mjs",
  use: {
    baseURL: "http://127.0.0.1:4173",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      // `Desktop Chrome` supplies 1280x720, which is now the policy's small-laptop cell instead of an undeclared
      // device constant: the specs that set no viewport are still measured at the same size, and the cell they are
      // measured in is one the population declares (and the matrix specs now evaluate too).
      use: { ...devices["Desktop Chrome"], viewport: DEFAULT_VIEWPORT },
    },
  ],
  webServer: {
    // --strictPort fails the browser launch instead of silently grabbing
    // another port, so the tests always exercise the 4173 origin the
    // specs bake into their baseURL/route patterns.
    command: "pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
