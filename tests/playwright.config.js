// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  reporter: [["list"]],
  use: { browserName: "webkit", viewport: { width: 1200, height: 800 } },
});
