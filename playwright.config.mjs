import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:8177",
    timezoneId: "Europe/Prague",
    launchOptions: {
      // v sandboxu/CI lze podstrčit vlastní chromium přes CHROMIUM_PATH
      executablePath: process.env.CHROMIUM_PATH || undefined,
    },
  },
  webServer: {
    command:
      "sh -c 'rm -rf .e2e-data && mkdir -p .e2e-data && "
      + "DB_PATH=.e2e-data/e2e.db python scripts/seed_demo.py && "
      + "DB_PATH=.e2e-data/e2e.db DISABLE_BACKGROUND=1 UPDATE_CHECK_URL= "
      + "python -m uvicorn app.main:app --port 8177'",
    url: "http://127.0.0.1:8177/api/range",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
