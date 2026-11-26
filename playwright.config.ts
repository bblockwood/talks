import { defineConfig, devices } from "@playwright/test";

// e2e runs against the Vite dev server and a local relay (`wrangler dev`, dev environment).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:5173/talks/" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:5173/talks/",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npm --prefix relay run dev",
      url: "http://localhost:8787/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
