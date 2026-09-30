import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.SEND_E2E_PORT ?? "8809");
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium", trace: "off" },
  webServer: {
    command: "npm run dev",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      SEND_PORT: String(port),
      SEND_STATE_DIR: `.wrangler/send-e2e-${randomUUID()}`,
      SEND_LOCAL_IP_LIMIT: "100",
    },
  },
});
