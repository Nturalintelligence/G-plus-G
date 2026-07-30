import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const localBrowsers = resolve("node_modules", "playwright-core", ".local-browsers");
const cli = resolve("node_modules", "playwright", "cli.js");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: "0",
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Local Playwright browser prepared at ${localBrowsers}`);
