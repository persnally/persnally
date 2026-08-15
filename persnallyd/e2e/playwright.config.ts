import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 45_000,
  workers: 1, // serial: tests mutate one seeded store in a known order
  retries: 0,
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
});
