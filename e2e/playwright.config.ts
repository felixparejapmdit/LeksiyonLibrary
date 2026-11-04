import { defineConfig } from '@playwright/test';

// Test-only ports, separate from the app's 47319, with a throwaway database.
export const APP_PORT = 47329;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    permissions: ['clipboard-read', 'clipboard-write'],
    // Traces and screenshots would show the sample lessons, so they are opt-in.
    trace: process.env.LV_DEBUG_ARTIFACTS ? 'retain-on-failure' : 'off',
    screenshot: process.env.LV_DEBUG_ARTIFACTS ? 'only-on-failure' : 'off',
  },
  webServer: {
    command: 'node support/start-servers.mjs',
    url: `http://127.0.0.1:${APP_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
