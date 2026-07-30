import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function bundledChromiumExecutable(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return undefined;
  const browsersRoot = join(resourcesPath, "playwright-browsers");
  if (!existsSync(browsersRoot)) return undefined;
  const chromiumDirectory = readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!chromiumDirectory) return undefined;
  const candidates =
    process.platform === "win32"
      ? [
          join(browsersRoot, chromiumDirectory, "chrome-win64", "chrome.exe"),
          join(browsersRoot, chromiumDirectory, "chrome-win", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? [
            join(
              browsersRoot,
              chromiumDirectory,
              "chrome-mac",
              "Chromium.app",
              "Contents",
              "MacOS",
              "Chromium",
            ),
          ]
        : [join(browsersRoot, chromiumDirectory, "chrome-linux", "chrome")];
  return candidates.find(existsSync);
}
