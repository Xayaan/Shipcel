import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    launchOptions: { channel: process.env.CI ? undefined : 'chrome' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    // The journeys drive every change themselves, without the minute schedule.
    command: 'CLOUDCEL_LOCAL_CRON=off npm run dev',
    url: 'http://127.0.0.1:5173/api/status',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
