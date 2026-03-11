import { defineConfig, devices } from '@playwright/test';

const headed = process.argv.includes('--headed');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  snapshotPathTemplate: '{testDir}/options/screenshots/{testFileName}/{arg}{ext}',
  use: {
    baseURL: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1280, height: 960 },
        deviceScaleFactor: 1,  // Fixed DPR for consistent screenshots
        launchOptions: headed ? {
          args: ['--auto-open-devtools-for-tabs'],
        } : {},
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 960 },
        deviceScaleFactor: 1,
        launchOptions: {
          firefoxUserPrefs: {
            'dom.storageManager.prompt.testing': true,
            'dom.storageManager.prompt.testing.allow': true,
          },
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'https://localhost:5173',
    reuseExistingServer: !process.env.CI,
    ignoreHTTPSErrors: true,
  },
});
