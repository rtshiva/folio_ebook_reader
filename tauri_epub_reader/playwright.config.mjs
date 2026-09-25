import { defineConfig } from '@playwright/test';

// Serves src/ (the app is a single static file, no build step) and runs
// the suites in tests/e2e. One worker: specs share port 8124 and the app
// keeps per-book in-memory state that parallel pages could disturb.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 15000,
  expect: { timeout: 9000 },
  fullyParallel: false,
  workers: 1,
  outputDir: 'tests/e2e/artifacts',
  use: {
    baseURL: 'http://127.0.0.1:8124',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 860 },
  },
  webServer: {
    command: 'node ./node_modules/http-server/bin/http-server src -p 8124 --silent',
    url: 'http://127.0.0.1:8124',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
