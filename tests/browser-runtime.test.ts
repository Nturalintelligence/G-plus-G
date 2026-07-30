import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromiumExecutable } from "../src/browser/runtime.js";

describe("browser runtime", () => {
  it("finds the newest project-local Windows Chromium", () => {
    const root = mkdtempSync(join(tmpdir(), "gpg-browser-"));
    const oldDirectory = join(root, "chromium-1000", "chrome-win64");
    const newestDirectory = join(root, "chromium-1234", "chrome-win64");
    mkdirSync(oldDirectory, { recursive: true });
    mkdirSync(newestDirectory, { recursive: true });
    writeFileSync(join(oldDirectory, "chrome.exe"), "");
    writeFileSync(join(newestDirectory, "chrome.exe"), "");
    expect(findChromiumExecutable(root, "win32"))
      .toBe(join(newestDirectory, "chrome.exe"));
  });

  it("returns undefined for a missing browser root", () => {
    expect(findChromiumExecutable(join(tmpdir(), `missing-${Date.now()}`), "win32"))
      .toBeUndefined();
  });
});
