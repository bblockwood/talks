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
    {
      // A production build (service worker included), pointed at the local relay, for e2e/w5.spec.ts.
      command:
        "npm run assets && VITE_RELAY_URL=ws://localhost:8787 npx vite build --outDir .e2e-dist --emptyOutDir && npx vite preview --outDir .e2e-dist",
      url: "http://localhost:4173/talks/",
      // Always rebuilt: an old preview left running would test an old build.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
