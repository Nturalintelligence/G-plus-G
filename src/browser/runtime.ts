import { existsSync } from "node:fs";
import { join } from "node:path";

export function bundledChromiumExecutable(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return undefined;
  const executable =
    process.platform === "win32"
      ? join(resourcesPath, "playwright-browsers", "chromium-1234", "chrome-win64", "chrome.exe")
      : process.platform === "darwin"
        ? join(
            resourcesPath,
            "playwright-browsers",
            "chromium-1234",
            "chrome-mac",
            "Chromium.app",
            "Contents",
            "MacOS",
            "Chromium",
          )
        : join(resourcesPath, "playwright-browsers", "chromium-1234", "chrome-linux", "chrome");
  return existsSync(executable) ? executable : undefined;
}
