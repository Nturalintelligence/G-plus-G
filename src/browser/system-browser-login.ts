import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

export function findSystemChrome(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const candidates = [
    environment.PROGRAMFILES
      ? join(environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : null,
    environment["PROGRAMFILES(X86)"]
      ? join(
          environment["PROGRAMFILES(X86)"],
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : null,
    environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null,
  ].filter((candidate): candidate is string => candidate !== null);

  const chrome = candidates.find(exists);
  if (!chrome) {
    throw new Error(
      "Google Chrome не найден. Установите обычный Chrome и повторите вход Gemini.",
    );
  }
  return chrome;
}

export async function loginInSystemChrome(
  profileDirectory: string,
  url: string,
): Promise<void> {
  const executable = findSystemChrome();
  console.log(
    "Открыт обычный Google Chrome. Войдите в Google, откройте Gemini и затем полностью закройте это окно Chrome.",
  );
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      url,
    ],
    {
      stdio: "ignore",
      windowsHide: false,
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Google Chrome завершился с кодом ${code}`));
    });
  });
}
