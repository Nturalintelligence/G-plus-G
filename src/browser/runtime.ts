import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function bundledChromiumExecutable(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const roots = [
    ...(resourcesPath ? [join(resourcesPath, "playwright-browsers")] : []),
    join(resolve(process.cwd()), "node_modules", "playwright-core", ".local-browsers"),
    ...(process.env.INIT_CWD
      ? [join(resolve(process.env.INIT_CWD), "node_modules", "playwright-core", ".local-browsers")]
      : []),
  ];
  return [...new Set(roots)].map((root) => findChromiumExecutable(root)).find(Boolean);
}

export function findChromiumExecutable(
  browsersRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!existsSync(browsersRoot)) return undefined;
  const chromiumDirectory = readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!chromiumDirectory) return undefined;
  const candidates =
    platform === "win32"
      ? [
          join(browsersRoot, chromiumDirectory, "chrome-win64", "chrome.exe"),
          join(browsersRoot, chromiumDirectory, "chrome-win", "chrome.exe"),
        ]
      : platform === "darwin"
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
