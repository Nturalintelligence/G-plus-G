import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureDataRoot } from "../src/paths.js";
import { logEvent, writeDiagnostic } from "../src/observability/logger.js";

const originalRoot = process.env.G_PLUS_G_USER_DATA;

afterEach(() => {
  if (originalRoot === undefined) delete process.env.G_PLUS_G_USER_DATA;
  else process.env.G_PLUS_G_USER_DATA = originalRoot;
});

describe("safe observability", () => {
  it("writes JSONL and redacts sensitive keys and token-like values", () => {
    const root = mkdtempSync(join(tmpdir(), "observability-"));
    configureDataRoot(root);
    logEvent("ERROR", "provider.login.failed", {
      provider: "chatgpt",
      token: "ghp_should-never-appear",
      message: "Bearer private-token",
    });
    const content = readFileSync(join(root, "logs", "application.jsonl"), "utf8");
    expect(content).toContain("provider.login.failed");
    expect(content).not.toContain("ghp_should-never-appear");
    expect(content).not.toContain("private-token");
  });

  it("creates a human-readable diagnostic report", () => {
    const root = mkdtempSync(join(tmpdir(), "diagnostic-"));
    configureDataRoot(root);
    const path = writeDiagnostic(new Error("login failed"), {
      operation: "provider:login",
    });
    const content = readFileSync(path, "utf8");
    expect(content).toContain("login failed");
    expect(content).toContain("provider:login");
  });
});
